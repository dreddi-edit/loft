import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function readServiceAccount(): ServiceAccountCredentials | null {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath || !existsSync(credentialsPath)) return null;
  return JSON.parse(readFileSync(credentialsPath, "utf8")) as ServiceAccountCredentials;
}

async function fetchTokenWithServiceAccount(credentials: ServiceAccountCredentials) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: credentials.token_uri ?? "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode(claim);
  const signInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signInput).sign(credentials.private_key, "base64url");
  const assertion = `${signInput}.${signature}`;

  const response = await fetch(credentials.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`GCP_TOKEN_FAILED:${response.status}`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("GCP_TOKEN_MISSING");
  return {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  };
}

async function fetchTokenFromMetadataServer() {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!response.ok) {
    throw new Error(`GCP_METADATA_TOKEN_FAILED:${response.status}`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("GCP_METADATA_TOKEN_MISSING");
  return {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  };
}

function fetchTokenWithGcloudCli() {
  const token = execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
  }).trim();
  if (!token) throw new Error("GCLOUD_TOKEN_MISSING");
  return { value: token, expiresAt: Date.now() + 3_000_000 };
}

export async function getGcpAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const serviceAccount = readServiceAccount();
  if (serviceAccount) {
    cachedToken = await fetchTokenWithServiceAccount(serviceAccount);
    return cachedToken.value;
  }

  try {
    cachedToken = await fetchTokenFromMetadataServer();
    return cachedToken.value;
  } catch {
    cachedToken = fetchTokenWithGcloudCli();
    return cachedToken.value;
  }
}
