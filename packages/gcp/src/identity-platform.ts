import { initializeApp, getApps, type App } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { isGcpConfigured, getGcpConfig } from "./config";

export type IdentitySession = {
  uid: string;
  email: string;
  emailVerified: boolean;
  customClaims: Record<string, unknown>;
};

let firebaseApp: App | null = null;

function getFirebaseApp(): App {
  if (firebaseApp) return firebaseApp;
  const existing = getApps()[0];
  if (existing) {
    firebaseApp = existing;
    return firebaseApp;
  }

  const config = getGcpConfig();
  firebaseApp = initializeApp({
    projectId: config.firebaseProjectId ?? config.projectId,
  });
  return firebaseApp;
}

export function isIdentityPlatformConfigured(): boolean {
  return isGcpConfigured() && process.env.GCP_IDENTITY_PLATFORM_ENABLED === "true";
}

export async function verifyIdToken(idToken: string): Promise<IdentitySession> {
  if (!isGcpConfigured()) {
    throw new Error("GCP_NOT_CONFIGURED");
  }

  const auth = getAuth(getFirebaseApp());
  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch {
    throw new Error("INVALID_ID_TOKEN");
  }

  return {
    uid: decoded.uid,
    email: decoded.email ?? "",
    emailVerified: decoded.email_verified ?? false,
    customClaims: {
      role: (decoded as DecodedIdToken & { role?: string }).role,
    },
  };
}

export async function setUserRole(uid: string, role: string): Promise<void> {
  if (!isGcpConfigured()) throw new Error("GCP_NOT_CONFIGURED");
  const auth = getAuth(getFirebaseApp());
  await auth.setCustomUserClaims(uid, { role });
}

export async function createIdentityUser(input: {
  email: string;
  password: string;
  displayName?: string;
  role?: string;
}): Promise<{ uid: string }> {
  if (!isGcpConfigured()) throw new Error("GCP_NOT_CONFIGURED");
  const auth = getAuth(getFirebaseApp());
  const user = await auth.createUser({
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    emailVerified: true,
  });
  if (input.role) {
    await auth.setCustomUserClaims(user.uid, { role: input.role });
  }
  return { uid: user.uid };
}
