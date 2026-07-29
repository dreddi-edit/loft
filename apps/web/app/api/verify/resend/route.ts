import {
  MAX_VERIFICATION_SENDS,
  NotificationService,
  VERIFICATION_RESEND_COOLDOWN_MS,
  buildVerificationEmail,
  issueVerification,
  salonRepository,
  verifyAppointmentAccessToken,
} from "@hair-simo/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, statusForCode, type ErrorCode } from "../../../../lib/api-errors";
import { apiRoute, type ApiLogger } from "../../../../lib/api-handler";

const notificationService = new NotificationService();

const RESEND_BODY_LIMIT_BYTES = 4_096;
const COOLDOWN_SECONDS = Math.ceil(VERIFICATION_RESEND_COOLDOWN_MS / 1_000);

/**
 * The appointment access token from the confirmation mail, never a bare appointment id:
 * this endpoint sends e-mail to an address the caller does not get to name, so the caller
 * has to prove they already control the booking it belongs to.
 */
const resendSchema = z
  .object({
    token: z.string().trim().min(16).max(2_048),
  })
  .strict();

type Appointment = NonNullable<Awaited<ReturnType<typeof salonRepository.findAppointmentById>>>;

function invalidToken(error: unknown): HttpError {
  return new HttpError("UNAUTHORIZED", {
    message: "This appointment link is invalid or has expired.",
    cause: error,
    logMessage: "appointment access token rejected",
  });
}

/**
 * Same two-pass check as /api/appointment/[token]: once to learn which row the token
 * names, once against that row's own ids so a token minted for one customer cannot be
 * replayed against another customer's appointment.
 */
async function loadAppointmentForToken(token: string): Promise<Appointment> {
  let appointmentId: string;
  try {
    appointmentId = (await verifyAppointmentAccessToken(token)).appointmentId;
  } catch (error) {
    throw invalidToken(error);
  }

  const appointment = await salonRepository.findAppointmentById(appointmentId);
  if (!appointment) {
    throw new HttpError("APPOINTMENT_NOT_FOUND", {
      logMessage: `appointment ${appointmentId} referenced by a valid token does not exist`,
    });
  }

  try {
    await verifyAppointmentAccessToken(token, {
      appointmentId: appointment.id,
      customerId: appointment.customerId,
    });
  } catch (error) {
    throw invalidToken(error);
  }

  return appointment;
}

/**
 * Thrown errors cannot carry a header through apiRoute, and a 429 without `Retry-After` is
 * the generic failure this endpoint is supposed to stop being, so the throttled answers are
 * built here and returned. The body keeps the ErrorResponseBody shape.
 */
function errorResponse(
  code: ErrorCode,
  message: string,
  requestId: string,
  retryAfterSeconds?: number,
): NextResponse {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (retryAfterSeconds !== undefined) headers["Retry-After"] = String(retryAfterSeconds);
  return NextResponse.json(
    { error: code, message, requestId },
    { status: statusForCode(code), headers },
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verifyUrlFor(locale: string, token: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  return `${baseUrl}/${locale}/verify/${encodeURIComponent(token)}`;
}

type Issued = Awaited<ReturnType<typeof issueVerification>>;

async function deliver(
  issued: Issued,
  log: ApiLogger,
): Promise<NextResponse | Record<string, unknown>> {
  const email = buildVerificationEmail({
    locale: issued.locale,
    verifyUrl: verifyUrlFor(issued.locale, issued.token),
    startsAt: issued.startsAt,
    endsAt: issued.endsAt,
    expiresAt: issued.expiresAt,
  });

  let status: string;
  try {
    const delivery = await notificationService.send({
      channel: "web",
      recipient: issued.recipient,
      subject: email.subject,
      message: email.message,
      locale: email.locale,
      eventType: "appointment.confirmation",
    });
    status = delivery.status;
    if (delivery.status === "failed" || delivery.status === "skipped") {
      log.error("verification mail was not delivered", {
        appointmentId: issued.appointmentId,
        deliveryStatus: delivery.status,
        deliveryReason: delivery.reason,
      });
    }
  } catch (error) {
    log.error("verification mail transport failed", {
      appointmentId: issued.appointmentId,
      reason: reasonOf(error),
    });
    status = "failed";
  }

  // The link was already rotated by issueVerification, so a send that never left the
  // process means the customer now holds no working link at all. That has to surface.
  if (status === "failed" || status === "skipped") {
    throw new HttpError("UPSTREAM_UNAVAILABLE", {
      message: "The confirmation e-mail could not be sent. Please try again later.",
      logMessage: `verification mail delivery ${status}`,
    });
  }

  return {
    data: {
      status,
      sendsRemaining: Math.max(0, MAX_VERIFICATION_SENDS - issued.sentCount),
    },
  };
}

export const POST = apiRoute<z.infer<typeof resendSchema>>(
  {
    route: "/api/verify/resend",
    methods: ["POST"],
    policy: "contact",
    bodyLimitBytes: RESEND_BODY_LIMIT_BYTES,
    schema: resendSchema,
  },
  async ({ body, requestId, log }) => {
    const appointment = await loadAppointmentForToken(body.token);

    let issued: Issued;
    try {
      issued = await issueVerification(appointment.id);
    } catch (error) {
      const code = reasonOf(error);
      switch (code) {
        case "VERIFICATION_ALREADY_VERIFIED":
          return { data: { status: "already_confirmed", sendsRemaining: 0 } };
        case "VERIFICATION_RESEND_TOO_SOON":
          log.warn("verification resend refused by cooldown", { appointmentId: appointment.id });
          return errorResponse(
            "RATE_LIMITED",
            "A confirmation e-mail was just sent. Please wait a moment before asking for another one.",
            requestId,
            COOLDOWN_SECONDS,
          );
        case "VERIFICATION_RESEND_LIMIT":
          // No Retry-After: the cap is absolute, waiting never makes this succeed.
          log.warn("verification resend refused by send cap", { appointmentId: appointment.id });
          return errorResponse(
            "RATE_LIMITED",
            "This booking has already received the maximum number of confirmation e-mails. Please call the salon.",
            requestId,
          );
        case "UNVERIFIED_BOOKING_LIMIT":
          log.warn("verification resend refused, customer holds too many unverified slots", {
            appointmentId: appointment.id,
          });
          return errorResponse(
            "RATE_LIMITED",
            "Too many unconfirmed bookings are open for this customer. Please confirm or cancel one first.",
            requestId,
          );
        case "APPOINTMENT_NOT_PENDING":
          throw new HttpError("CONFLICT", {
            message: "This appointment no longer needs to be confirmed.",
            cause: error,
            logMessage: code,
          });
        case "CUSTOMER_EMAIL_MISSING":
          throw new HttpError("CONFLICT", {
            message: "No e-mail address is stored for this booking. Please call the salon.",
            cause: error,
            logMessage: code,
          });
        case "VERIFICATION_ISSUE_CONFLICT":
          throw new HttpError("CONFLICT", {
            message: "The confirmation link is being updated. Please try again in a moment.",
            cause: error,
            logMessage: code,
          });
        default:
          throw error;
      }
    }

    return deliver(issued, log);
  },
);
