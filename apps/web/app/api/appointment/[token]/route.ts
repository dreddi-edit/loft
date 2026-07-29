import { BookingService, salonRepository, verifyAppointmentAccessToken } from "@hair-simo/core";
import { z } from "zod";
import { HttpError } from "../../../../lib/api-errors";
import { apiRoute } from "../../../../lib/api-handler";
import { withDomainErrors } from "../../_lib/domain-errors";

const bookingService = new BookingService();

const MANAGE_BODY_LIMIT_BYTES = 2_048;
const DEFAULT_CANCEL_REASON = "customer request";

type TokenParams = { token: string };
type Appointment = NonNullable<Awaited<ReturnType<typeof salonRepository.findAppointmentById>>>;

const manageActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("cancel"),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("reschedule"),
    startsAt: z.string().trim().datetime(),
  }),
]);

function invalidToken(error: unknown): HttpError {
  return new HttpError("UNAUTHORIZED", {
    message: "This appointment link is invalid or has expired.",
    cause: error,
    logMessage: "appointment access token rejected",
  });
}

/**
 * The token names the appointment, so it is verified twice: once to learn which row to
 * read, and once against that row's own ids. The second pass is what stops a token minted
 * for one customer from being replayed against another customer's appointment — the GET
 * path used to check it and the POST path did not, so cancel and reschedule ran on the
 * claim alone.
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
 * A manage link travels by email and lives in browser history, so the response carries
 * only what the manage screen renders. Contact details are not part of it.
 */
function present(appointment: Appointment) {
  return {
    id: appointment.id,
    status: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    locale: appointment.locale,
    service: {
      slug: appointment.service.slug,
      translations: appointment.service.translations.map((entry) => ({
        locale: entry.locale,
        name: entry.name,
      })),
    },
    staff: appointment.staff ? { displayName: appointment.staff.displayName } : null,
    customer: {
      firstName: appointment.customer.firstName,
      lastName: appointment.customer.lastName,
    },
  };
}

async function presentById(appointmentId: string) {
  const appointment = await salonRepository.findAppointmentById(appointmentId);
  if (!appointment) {
    throw new HttpError("APPOINTMENT_NOT_FOUND", {
      logMessage: `appointment ${appointmentId} disappeared while being managed`,
    });
  }
  return present(appointment);
}

export const GET = apiRoute<unknown, undefined, TokenParams>(
  {
    route: "/api/appointment/[token]",
    methods: ["GET"],
    policy: "availability",
  },
  async ({ params }) => ({ data: present(await loadAppointmentForToken(params.token)) }),
);

export const POST = apiRoute<z.infer<typeof manageActionSchema>, undefined, TokenParams>(
  {
    route: "/api/appointment/[token]",
    methods: ["POST"],
    policy: "booking",
    bodyLimitBytes: MANAGE_BODY_LIMIT_BYTES,
    schema: manageActionSchema,
  },
  async ({ body, params }) => {
    const appointment = await loadAppointmentForToken(params.token);

    if (body.action === "cancel") {
      const reason = body.reason && body.reason.length > 0 ? body.reason : DEFAULT_CANCEL_REASON;
      await withDomainErrors(() => bookingService.cancel(appointment.id, reason));
      return { data: await presentById(appointment.id) };
    }

    await withDomainErrors(() => bookingService.reschedule(appointment.id, body.startsAt));
    return { data: await presentById(appointment.id) };
  },
);
