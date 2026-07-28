import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

const payloadSchema = z.object({
  appointmentId: z.string().min(1),
  customerId: z.string().min(1),
});

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET_MISSING");
  return new TextEncoder().encode(secret);
}

export async function createAppointmentAccessToken(input: { appointmentId: string; customerId: string }) {
  return new SignJWT(input)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
}

export async function verifyAppointmentAccessToken(token: string) {
  const { payload } = await jwtVerify(token, getSecret());
  return payloadSchema.parse(payload);
}
