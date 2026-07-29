import {
  WaitlistError,
  WaitlistService,
  createAppointmentAccessToken,
  offerExpiresAt,
  readWaitlistOfferToken,
  type WaitlistClaimResult,
  type WaitlistOfferClaims,
} from "@hair-simo/core";
import { prisma } from "@hair-simo/db";
import { resolveLocale } from "@hair-simo/i18n";
import { z } from "zod";
import { HttpError, type ErrorCode } from "../../../../lib/api-errors";
import { apiRoute, type ApiLogger } from "../../../../lib/api-handler";

const waitlistService = new WaitlistService();

const CLAIM_BODY_LIMIT_BYTES = 1_024;
const MS_PER_MINUTE = 60_000;

type TokenParams = { token: string };
type OfferState = "open" | "expired" | "claimed" | "unavailable";

/**
 * The offer token is the only authority on this endpoint, so the body carries nothing at
 * all — in particular no entry id. Accepting one would mean a caller could point a token
 * they legitimately hold at somebody else's waitlist entry.
 */
const claimSchema = z.object({}).strict();

type DomainMapping = { code: ErrorCode; message: string };

const CLAIM_ERRORS: Record<string, DomainMapping> = {
  OFFER_TOKEN_INVALID: {
    code: "UNAUTHORIZED",
    message: "This waitlist link is invalid or has expired.",
  },
  ENTRY_NOT_FOUND: {
    code: "NOT_FOUND",
    message: "This waitlist request no longer exists.",
  },
  ENTRY_CANCELLED: {
    code: "CONFLICT",
    message: "This waitlist request was withdrawn.",
  },
  SERVICE_NOT_FOUND: {
    code: "SERVICE_NOT_FOUND",
    message: "The requested service does not exist.",
  },
  SERVICE_INACTIVE: {
    code: "SERVICE_NOT_FOUND",
    message: "This service cannot be booked at the moment.",
  },
};

function translateWaitlistError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (!(error instanceof Error)) return error;
  const key = error instanceof WaitlistError ? error.code : error.message.split(":", 1)[0].trim();
  const mapping = CLAIM_ERRORS[key];
  if (!mapping) return error;
  return new HttpError(mapping.code, {
    message: mapping.message,
    cause: error,
    logMessage: error.message,
  });
}

async function withWaitlistErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translateWaitlistError(error);
  }
}

function invalidLink(logMessage: string): HttpError {
  return new HttpError("UNAUTHORIZED", {
    message: "This waitlist link is invalid or has expired.",
    logMessage,
  });
}

/**
 * Verifies the HMAC and the payload shape before anything is read or written. A token that
 * does not verify never reaches the database, so the path segment cannot be used to probe
 * for entry ids. A missing signing secret throws OFFER_SECRET_MISSING out of here, which is
 * unmapped on purpose and surfaces as 500 rather than as "invalid link".
 */
function readClaims(token: string): WaitlistOfferClaims {
  const claims = readWaitlistOfferToken(token);
  if (!claims) throw invalidLink("waitlist offer token rejected");
  return claims;
}

/**
 * Two taps on the confirmation link a few milliseconds apart both enter the serializable
 * claim transaction; the second one loses the write conflict, is retried inside the service,
 * re-reads an entry that is now `converted` and reports OFFER_NOT_ACTIVE. Claiming once more
 * turns that into the idempotent "you already have this appointment" answer, because `claim`
 * short-circuits on a converted entry whose appointment matches the slot in the token. The
 * retry is bounded to one extra attempt and creates nothing by itself.
 */
async function claimIdempotently(entryId: string, token: string): Promise<WaitlistClaimResult> {
  const first = await waitlistService.claim(entryId, { token });
  if (first.won || first.reason !== "OFFER_NOT_ACTIVE") return first;
  return waitlistService.claim(entryId, { token });
}

/**
 * Minted after the appointment exists. The claimer proved control of the customer's contact
 * channel by holding the offer token, so handing them the manage link for the appointment
 * just created for that customer is safe — but a failure here must not turn a booked slot
 * into an error response.
 */
async function manageUrlFor(
  appointment: { id: string; customerId: string; locale: string },
  log: ApiLogger,
): Promise<string | null> {
  try {
    const token = await createAppointmentAccessToken({
      appointmentId: appointment.id,
      customerId: appointment.customerId,
    });
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    return `${baseUrl}/${resolveLocale(appointment.locale)}/manage/${token}`;
  } catch (error) {
    log.error("waitlist manage link could not be created", {
      appointmentId: appointment.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const GET = apiRoute<unknown, undefined, TokenParams>(
  {
    route: "/api/waitlist/[token]",
    methods: ["GET"],
    policy: "availability",
  },
  async ({ params }) => {
    const claims = readClaims(params.token);
    const entry = await prisma.waitlist.findUnique({
      where: { id: claims.entryId },
      select: {
        status: true,
        notifiedAt: true,
        service: {
          select: {
            slug: true,
            durationMin: true,
            translations: { select: { locale: true, name: true } },
          },
        },
      },
    });
    if (!entry) {
      throw new HttpError("NOT_FOUND", {
        message: "This waitlist request no longer exists.",
        logMessage: `waitlist entry ${claims.entryId} referenced by a valid token does not exist`,
      });
    }

    const startsAt = claims.slotStartsAt;
    const endsAt = new Date(startsAt.getTime() + entry.service.durationMin * MS_PER_MINUTE);
    const expiresAt = offerExpiresAt(new Date(claims.notifiedAtMs), startsAt);
    const live = entry.status === "notified" && entry.notifiedAt?.getTime() === claims.notifiedAtMs;

    let state: OfferState = "open";
    if (entry.status === "converted") state = "claimed";
    else if (!live) state = "unavailable";
    else if (Date.now() >= expiresAt.getTime()) state = "expired";

    return {
      data: {
        state,
        slot: { startsAt, endsAt },
        offerExpiresAt: expiresAt,
        service: { slug: entry.service.slug, translations: entry.service.translations },
      },
    };
  },
);

/**
 * W4 over HTTP. Losing the race is an outcome, not a client error: the customer clicked a
 * link that was valid when it was sent, so the response is 200 with `claimed: false` and a
 * machine-readable reason the claim page can translate, rather than an error body. The id of
 * the appointment that won is never disclosed — it usually belongs to somebody else.
 */
export const POST = apiRoute<z.infer<typeof claimSchema>, undefined, TokenParams>(
  {
    route: "/api/waitlist/[token]",
    methods: ["POST"],
    policy: "booking",
    accept: ["json", "form", "none"],
    bodyLimitBytes: CLAIM_BODY_LIMIT_BYTES,
    schema: claimSchema,
  },
  async ({ params, log }) => {
    const claims = readClaims(params.token);
    const result = await withWaitlistErrors(() => claimIdempotently(claims.entryId, params.token));

    if (!result.won) return { data: { claimed: false, reason: result.reason } };

    const { appointment } = result;
    return {
      data: {
        claimed: true,
        alreadyClaimed: result.alreadyClaimed,
        appointment: {
          id: appointment.id,
          status: appointment.status,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
        },
        manageUrl: await manageUrlFor(appointment, log),
      },
    };
  },
);
