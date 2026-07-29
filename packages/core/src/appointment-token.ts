import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { TOKEN_ISSUER, resolveTokenSecret, timingSafeStringEqual } from "./auth-service";

export const APPOINTMENT_TOKEN_AUDIENCE = "hair-simo-appointment";
export const APPOINTMENT_TOKEN_TYPE = "appointment-access";

// The link travels by e-mail and ends up in access logs and Referer headers, and there is
// no revocation list. It only has to outlive the appointment it manages, so the lifetime
// is derived from the appointment start plus a short grace window for post-visit access,
// and falls back to 14 days when the caller does not pass the start time.
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;
const POST_APPOINTMENT_GRACE_SECONDS = 60 * 60 * 48;
const MIN_TTL_SECONDS = 60 * 60 * 24;
const MAX_TTL_SECONDS = 60 * 60 * 24 * 45;
const CLOCK_TOLERANCE_SECONDS = 30;

const claimsSchema = z.object({
  typ: z.literal(APPOINTMENT_TOKEN_TYPE),
  appointmentId: z.string().min(1),
  customerId: z.string().min(1),
});

export type AppointmentAccessClaims = z.infer<typeof claimsSchema>;

export type AppointmentAccessTokenInput = {
  appointmentId: string;
  customerId: string;
  startsAt?: Date | string;
};

function lifetimeSeconds(nowSeconds: number, startsAt?: Date | string) {
  if (!startsAt) return DEFAULT_TTL_SECONDS;
  const startsAtMs = new Date(startsAt).getTime();
  if (!Number.isFinite(startsAtMs)) return DEFAULT_TTL_SECONDS;
  const untilAppointment = Math.floor(startsAtMs / 1000) - nowSeconds;
  return Math.min(
    MAX_TTL_SECONDS,
    Math.max(MIN_TTL_SECONDS, untilAppointment + POST_APPOINTMENT_GRACE_SECONDS),
  );
}

export async function createAppointmentAccessToken(input: AppointmentAccessTokenInput) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({
    typ: APPOINTMENT_TOKEN_TYPE,
    appointmentId: input.appointmentId,
    customerId: input.customerId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(APPOINTMENT_TOKEN_AUDIENCE)
    .setSubject(input.appointmentId)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds(issuedAt, input.startsAt))
    .sign(resolveTokenSecret("APPOINTMENT_TOKEN_SECRET"));
}

export async function verifyAppointmentAccessToken(
  token: string,
  expected?: { appointmentId?: string; customerId?: string },
) {
  const { payload } = await jwtVerify(token, resolveTokenSecret("APPOINTMENT_TOKEN_SECRET"), {
    algorithms: ["HS256"],
    issuer: TOKEN_ISSUER,
    audience: APPOINTMENT_TOKEN_AUDIENCE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });
  const claims = claimsSchema.parse(payload);

  if (!payload.sub || !timingSafeStringEqual(payload.sub, claims.appointmentId)) {
    throw new Error("APPOINTMENT_TOKEN_BINDING_MISMATCH");
  }
  if (
    expected?.appointmentId &&
    !timingSafeStringEqual(expected.appointmentId, claims.appointmentId)
  ) {
    throw new Error("APPOINTMENT_TOKEN_BINDING_MISMATCH");
  }
  if (expected?.customerId && !timingSafeStringEqual(expected.customerId, claims.customerId)) {
    throw new Error("APPOINTMENT_TOKEN_BINDING_MISMATCH");
  }

  return { appointmentId: claims.appointmentId, customerId: claims.customerId };
}
