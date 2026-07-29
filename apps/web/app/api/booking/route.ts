import {
  BookingService,
  NotificationService,
  createAppointmentAccessToken,
  formatSalonTimeRange,
} from "@hair-simo/core";
import type { AppLocale } from "@hair-simo/i18n";
import { z } from "zod";
import { apiRoute, type ApiLogger } from "../../../lib/api-handler";
import { withDomainErrors } from "../_lib/domain-errors";

const bookingService = new BookingService();
const notificationService = new NotificationService();

const BOOKING_BODY_LIMIT_BYTES = 8_192;

/** A form post carries "true"/"false" strings; a JSON post carries real booleans. */
const booleanish = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

const bookingSchema = z.object({
  serviceSlug: z.string().trim().min(1).max(100),
  startsAt: z.string().trim().datetime(),
  customerEmail: z.string().trim().email().max(254),
  customerFirstName: z.string().trim().min(1).max(100).optional(),
  customerLastName: z.string().trim().min(1).max(100).optional(),
  customerPhone: z.string().trim().min(1).max(30).optional(),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
  sourceChannel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
  staffId: z.string().trim().min(1).max(64).optional(),
  marketingOptIn: booleanish.optional(),
  termsAccepted: booleanish.refine((value) => value, {
    message: "The terms have to be accepted.",
  }),
});

type Appointment = Awaited<ReturnType<BookingService["createBooking"]>>;

type ConfirmationStatus =
  | "sent"
  | "simulated"
  | "scheduled"
  | "failed"
  | "skipped"
  | "no-recipient";

type PostCommitResult = {
  manageUrl: string | null;
  confirmation: { requested: boolean; status: ConfirmationStatus };
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything here happens AFTER the appointment row exists. A Gmail outage, a missing
 * APPOINTMENT_TOKEN_SECRET or any other side effect failing must not turn into an error
 * response: the customer would read "booking failed" and book the same slot twice. The
 * outcome is reported in the payload instead, and logged for the salon to chase.
 */
async function runPostCommitEffects(
  appointment: Appointment,
  locale: AppLocale,
  log: ApiLogger,
): Promise<PostCommitResult> {
  let manageUrl: string | null = null;
  try {
    const manageToken = await createAppointmentAccessToken({
      appointmentId: appointment.id,
      customerId: appointment.customerId,
    });
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    manageUrl = `${baseUrl}/${locale}/manage/${manageToken}`;
  } catch (error) {
    log.error("manage link could not be created", {
      appointmentId: appointment.id,
      reason: reasonOf(error),
    });
  }

  const recipient = appointment.customer.email;
  if (!recipient) {
    return { manageUrl, confirmation: { requested: false, status: "no-recipient" } };
  }

  try {
    const result = await notificationService.sendBookingConfirmation({
      appointmentId: appointment.id,
      recipient,
      locale,
      timeLabel: formatSalonTimeRange(appointment.startsAt, appointment.endsAt, locale),
      manageUrl: manageUrl ?? undefined,
    });
    if (result.delivery.status !== "sent") {
      log.warn("booking confirmation was not delivered", {
        appointmentId: appointment.id,
        deliveryStatus: result.delivery.status,
        deliveryReason: result.delivery.reason,
      });
    }
    return { manageUrl, confirmation: { requested: true, status: result.delivery.status } };
  } catch (error) {
    log.error("booking confirmation failed", {
      appointmentId: appointment.id,
      reason: reasonOf(error),
    });
    return { manageUrl, confirmation: { requested: true, status: "failed" } };
  }
}

export const POST = apiRoute<z.infer<typeof bookingSchema>>(
  {
    route: "/api/booking",
    methods: ["POST"],
    policy: "booking",
    accept: ["json", "form"],
    bodyLimitBytes: BOOKING_BODY_LIMIT_BYTES,
    schema: bookingSchema,
    successStatus: 201,
  },
  async ({ body, log }) => {
    const appointment = await withDomainErrors(() => bookingService.createBooking(body));
    const { manageUrl, confirmation } = await runPostCommitEffects(appointment, body.locale, log);
    // The manage token is a JWT: it is emailed, ends up in logs and browser history, so the
    // response carries the link only. Nothing in apps/web consumes the bare token.
    return { data: { ...appointment, manageUrl, confirmation } };
  },
);
