// In-process login throttle. It is per Cloud Run instance, so a client that lands on a
// fresh instance starts with a clean counter; Cloud Armor rate limiting at the load
// balancer is the second layer that covers the fleet.

const FREE_ATTEMPTS = 3;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60_000;
const ATTEMPT_WINDOW_MS = 30 * 60_000;
const MAX_BUCKETS = 5_000;

// x-forwarded-for on Cloud Run behind a global external load balancer looks like
// "<client supplied, spoofable>, <client ip seen by the LB>, <LB ip>". Everything left of
// the trailing infrastructure entries is attacker controlled, so we count from the right.
// TRUSTED_PROXY_HOPS is the number of trailing entries appended by our own infrastructure
// (1 = the global LB), which makes the client the second entry from the right.
const DEFAULT_TRUSTED_PROXY_HOPS = 1;

type Bucket = { failures: number; blockedUntil: number; lastFailureAt: number };

export type LoginThrottleIdentity = { ip: string; email?: string };
export type LoginThrottleDecision = { allowed: boolean; retryAfterSeconds: number };

const buckets = new Map<string, Bucket>();

function trustedProxyHops() {
  const configured = Number(process.env.TRUSTED_PROXY_HOPS);
  if (!Number.isInteger(configured) || configured < 0) return DEFAULT_TRUSTED_PROXY_HOPS;
  return configured;
}

export function extractClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length) {
      const index = Math.max(0, entries.length - 1 - trustedProxyHops());
      return entries[index] ?? "unknown";
    }
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

function keysFor(identity: LoginThrottleIdentity) {
  const keys = [`ip:${identity.ip}`];
  const email = identity.email?.trim().toLowerCase();
  if (email) keys.push(`email:${email}`);
  return keys;
}

function prune(now: number) {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.blockedUntil <= now && now - bucket.lastFailureAt > ATTEMPT_WINDOW_MS) {
      buckets.delete(key);
    }
  }
  for (const key of buckets.keys()) {
    if (buckets.size <= MAX_BUCKETS) break;
    buckets.delete(key);
  }
}

function backoffMs(failures: number) {
  if (failures <= FREE_ATTEMPTS) return 0;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS - 1));
}

export function checkLoginThrottle(
  identity: LoginThrottleIdentity,
  now: number = Date.now(),
): LoginThrottleDecision {
  let blockedUntil = 0;
  for (const key of keysFor(identity)) {
    const bucket = buckets.get(key);
    if (bucket && bucket.blockedUntil > now) {
      blockedUntil = Math.max(blockedUntil, bucket.blockedUntil);
    }
  }
  if (!blockedUntil) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.ceil((blockedUntil - now) / 1000) };
}

export function recordLoginFailure(identity: LoginThrottleIdentity, now: number = Date.now()) {
  for (const key of keysFor(identity)) {
    const existing = buckets.get(key);
    const stale = !existing || now - existing.lastFailureAt > ATTEMPT_WINDOW_MS;
    const failures = stale ? 1 : existing.failures + 1;
    buckets.set(key, {
      failures,
      lastFailureAt: now,
      blockedUntil: now + backoffMs(failures),
    });
  }
  prune(now);
}

export function recordLoginSuccess(identity: LoginThrottleIdentity) {
  for (const key of keysFor(identity)) {
    buckets.delete(key);
  }
}

export function resetLoginThrottle() {
  buckets.clear();
}
