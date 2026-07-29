import { WaitlistError, WaitlistService, salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { HttpError, type ErrorCode } from "../../../lib/api-errors";
import { apiRoute } from "../../../lib/api-handler";

const waitlistService = new WaitlistService();

const WAITLIST_BODY_LIMIT_BYTES = 4_096;

/** A form post carries "true"/"false" strings; a JSON post carries real booleans. */
const booleanish = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

/**
 * The caller names the service by slug and themselves by email, exactly like /api/booking.
 * A raw `customerId` is deliberately absent: this endpoint is unauthenticated, so accepting
 * one would let anybody attach waitlist rows to a stranger's customer record.
 */
const joinSchema = z
  .object({
    serviceSlug: z.string().trim().min(1).max(100),
    staffId: z.string().trim().min(1).max(64).optional(),
    earliestAt: z.string().trim().datetime(),
    latestAt: z.string().trim().datetime(),
    customerEmail: z.string().trim().email().max(254),
    customerFirstName: z.string().trim().min(1).max(100).optional(),
    customerLastName: z.string().trim().min(1).max(100).optional(),
    customerPhone: z.string().trim().min(1).max(30).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).default("en"),
    channel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
    termsAccepted: booleanish.refine((value) => value, {
      message: "The terms have to be accepted.",
    }),
  })
  .strict();

type DomainMapping = { code: ErrorCode; message: string };

/**
 * WaitlistError codes and the plain error strings the customer repository throws, mapped
 * onto the HTTP taxonomy. Anything missing stays unmapped and is reported as INTERNAL, so
 * configuration failures such as OFFER_SECRET_MISSING never reach a client.
 */
const JOIN_ERRORS: Record<string, DomainMapping> = {
  INVALID_INPUT: {
    code: "VALIDATION_ERROR",
    message: "The waitlist request is incomplete or malformed.",
  },
  SERVICE_NOT_FOUND: {
    code: "SERVICE_NOT_FOUND",
    message: "The requested service does not exist.",
  },
  SERVICE_INACTIVE: {
    code: "SERVICE_NOT_FOUND",
    message: "This service cannot be booked at the moment.",
  },
  STAFF_NOT_FOUND: {
    code: "NOT_FOUND",
    message: "The selected stylist does not exist.",
  },
  STAFF_NOT_ELIGIBLE: {
    code: "STAFF_NOT_ELIGIBLE",
    message: "The selected stylist cannot perform this service.",
  },
  WINDOW_INVALID: {
    code: "VALIDATION_ERROR",
    message: "The end of the requested window has to be after its start.",
  },
  WINDOW_IN_PAST: {
    code: "VALIDATION_ERROR",
    message: "The requested window has already passed.",
  },
  WINDOW_TOO_SHORT: {
    code: "VALIDATION_ERROR",
    message: "The requested window is shorter than the treatment takes.",
  },
  WINDOW_TOO_LONG: {
    code: "VALIDATION_ERROR",
    message: "The requested window covers too many days.",
  },
  WINDOW_TOO_FAR_AHEAD: {
    code: "VALIDATION_ERROR",
    message: "The calendar is not open that far ahead yet.",
  },
  TOO_MANY_WAITLIST_ENTRIES: {
    code: "CONFLICT",
    message: "You already have the maximum number of open waitlist requests.",
  },
  CUSTOMER_NOT_FOUND: {
    code: "CONFLICT",
    message: "This email address cannot be added to the waitlist. Please contact the salon.",
  },
  CUSTOMER_DELETED: {
    code: "CONFLICT",
    message: "This email address cannot be added to the waitlist. Please contact the salon.",
  },
  CUSTOMER_ANONYMIZED: {
    code: "CONFLICT",
    message: "This email address cannot be added to the waitlist. Please contact the salon.",
  },
};

function translateWaitlistError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (!(error instanceof Error)) return error;
  const key = error instanceof WaitlistError ? error.code : error.message.split(":", 1)[0].trim();
  const mapping = JOIN_ERRORS[key];
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

/**
 * W1 over HTTP: an unauthenticated customer asks to be told when a slot frees up.
 *
 * The response is deliberately uniform. `join` also reports whether an equivalent open
 * entry already existed and which appointments the customer already holds inside the
 * window, and both of those would turn this endpoint into an oracle: post a stranger's
 * address and learn whether they are on the list or booked. The caller only learns that
 * their own request was accepted.
 */
export const POST = apiRoute<z.infer<typeof joinSchema>>(
  {
    route: "/api/waitlist",
    methods: ["POST"],
    policy: "booking",
    accept: ["json", "form"],
    bodyLimitBytes: WAITLIST_BODY_LIMIT_BYTES,
    schema: joinSchema,
  },
  async ({ body }) => {
    const service = await salonRepository.findServiceBySlug(body.serviceSlug);
    if (!service || !service.isActive) {
      throw new HttpError("SERVICE_NOT_FOUND", {
        logMessage: `waitlist join for unknown or inactive service "${body.serviceSlug}"`,
      });
    }

    const customer = await withWaitlistErrors(() =>
      salonRepository.findOrCreateCustomerByEmail(body.customerEmail, body.locale, body.channel, {
        firstName: body.customerFirstName,
        lastName: body.customerLastName,
        phone: body.customerPhone,
      }),
    );

    await salonRepository.recordConsent(customer.id, "terms", true, "waitlist");

    await withWaitlistErrors(() =>
      waitlistService.join({
        customerId: customer.id,
        serviceId: service.id,
        staffId: body.staffId,
        earliestAt: body.earliestAt,
        latestAt: body.latestAt,
        locale: body.locale,
        channel: body.channel,
      }),
    );

    return {
      data: {
        status: "queued",
        serviceSlug: body.serviceSlug,
        earliestAt: body.earliestAt,
        latestAt: body.latestAt,
      },
    };
  },
);
