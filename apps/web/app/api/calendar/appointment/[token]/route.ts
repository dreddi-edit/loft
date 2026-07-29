import {
  ICS_CONTENT_TYPE,
  buildAppointmentIcs,
  buildCancellationIcs,
  icsFilename,
  salonRepository,
  toIcsAppointment,
  verifyAppointmentAccessToken,
} from "@hair-simo/core";
import { HttpError } from "../../../../../lib/api-errors";
import { apiRoute } from "../../../../../lib/api-handler";

type TokenParams = { token: string };
type Appointment = NonNullable<Awaited<ReturnType<typeof salonRepository.findAppointmentById>>>;

const MAX_TOKEN_LENGTH = 2_048;

function normalizeToken(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const trimmed = value.trim();
  // A confirmation mail may link to `<token>.ics` so the client picks the calendar app.
  // The signature segment of an HS256 JWT cannot contain a dot, so this is unambiguous.
  return trimmed.toLowerCase().endsWith(".ics") ? trimmed.slice(0, -4) : trimmed;
}

function invalidToken(error: unknown): HttpError {
  return new HttpError("UNAUTHORIZED", {
    message: "This appointment link is invalid or has expired.",
    cause: error,
    logMessage: "appointment access token rejected",
  });
}

/**
 * Same two-pass check as /api/appointment/[token]: the token names the appointment, and
 * the row it named is then verified against the token's own binding. A bare appointment id
 * from the request never selects the row.
 */
async function loadAppointmentForToken(rawToken: string): Promise<Appointment> {
  const token = normalizeToken(rawToken);
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw invalidToken(new Error("APPOINTMENT_TOKEN_LENGTH_REJECTED"));
  }

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
 * The "add to calendar" file from the confirmation mail. The body is raw iCalendar rather
 * than the `{ data }` envelope because the browser hands it straight to a calendar app;
 * `apiRoute` passes the `Response` through and keeps the method guard, the limiter and the
 * error taxonomy.
 *
 * A cancelled appointment answers with METHOD:CANCEL under the same UID, so opening the
 * link after a cancellation removes the event instead of re-adding it.
 *
 * The manage link is deliberately not embedded: it is a bearer credential, and a calendar
 * entry is far more widely shared than the mail the customer received it in.
 */
export const GET = apiRoute<unknown, undefined, TokenParams>(
  {
    route: "/api/calendar/appointment/[token]",
    methods: ["GET", "HEAD"],
    policy: "availability",
  },
  async ({ params, log }) => {
    const appointment = await loadAppointmentForToken(params.token);
    const input = toIcsAppointment(appointment);
    const cancelled = appointment.status === "cancelled";
    const calendar = cancelled ? buildCancellationIcs(input) : buildAppointmentIcs(input);

    log.info("appointment calendar file served", {
      appointmentId: appointment.id,
      cancelled,
    });

    return new Response(calendar, {
      status: 200,
      headers: {
        "content-type": ICS_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${icsFilename(appointment.id)}"`,
        "cache-control": "private, no-store",
      },
    });
  },
);
