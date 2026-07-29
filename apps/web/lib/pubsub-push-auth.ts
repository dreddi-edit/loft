import { HttpError } from "./api-errors";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function verifyPubSubPushToken(headers: Headers, audience: string): Promise<void> {
  if (!isProduction()) return;

  const authorization = headers.get("authorization");
  const match = authorization ? /^bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  const token = match?.[1]?.trim();
  if (!token) {
    throw new HttpError("UNAUTHORIZED", { logMessage: "pubsub push missing bearer token" });
  }

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`,
  );
  if (!response.ok) {
    throw new HttpError("UNAUTHORIZED", { logMessage: "pubsub push token rejected by Google" });
  }

  const payload = (await response.json()) as { aud?: string; email_verified?: string };
  if (payload.aud !== audience) {
    throw new HttpError("UNAUTHORIZED", {
      logMessage: `pubsub push audience mismatch: expected ${audience}`,
    });
  }
}
