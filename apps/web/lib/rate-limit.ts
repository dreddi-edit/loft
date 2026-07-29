export type RateLimitPolicy = {
  limit: number;
  windowMs: number;
  burst?: number;
};

export type RateLimitPolicyName =
  "booking" | "chat" | "voice" | "contact" | "availability" | "payment" | "publicRead" | "internal";

/**
 * Sized for a single salon in Brixen, not for a SaaS tenant. `limit` is the sustained
 * allowance inside `windowMs`; `burst` is extra headroom a client may consume in the same
 * window, so the enforced ceiling is `limit + burst`.
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitPolicyName, RateLimitPolicy> = {
  booking: { limit: 5, windowMs: 600_000, burst: 2 },
  chat: { limit: 15, windowMs: 300_000, burst: 5 },
  voice: { limit: 8, windowMs: 300_000, burst: 4 },
  contact: { limit: 3, windowMs: 3_600_000, burst: 2 },
  availability: { limit: 60, windowMs: 60_000, burst: 30 },
  payment: { limit: 20, windowMs: 300_000, burst: 10 },
  publicRead: { limit: 120, windowMs: 60_000, burst: 60 },
  internal: { limit: 60, windowMs: 60_000, burst: 30 },
};

export function effectiveLimit(policy: RateLimitPolicy): number {
  return policy.limit + (policy.burst ?? 0);
}

export type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export interface RateLimitStore {
  get(key: string, now?: number): Promise<RateLimitEntry | null>;
  increment(key: string, windowMs: number, now?: number): Promise<RateLimitEntry>;
  reset(key: string): Promise<void>;
}

export type MemoryRateLimitStoreOptions = {
  maxEntries?: number;
  sweepIntervalMs?: number;
};

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  get size(): number {
    return this.entries.size;
  }

  incrementSync(key: string, windowMs: number, now: number = Date.now()): RateLimitEntry {
    this.sweep(now);
    const existing = this.entries.get(key);
    if (!existing || existing.resetAt <= now) {
      const created: RateLimitEntry = { count: 1, resetAt: now + windowMs };
      this.entries.set(key, created);
      this.evict();
      return { ...created };
    }
    existing.count += 1;
    return { ...existing };
  }

  async get(key: string, now: number = Date.now()): Promise<RateLimitEntry | null> {
    const existing = this.entries.get(key);
    if (!existing) return null;
    if (existing.resetAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return { ...existing };
  }

  async increment(
    key: string,
    windowMs: number,
    now: number = Date.now(),
  ): Promise<RateLimitEntry> {
    return this.incrementSync(key, windowMs, now);
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.lastSweepAt = 0;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const excess = this.entries.size - this.maxEntries;
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let index = 0; index < excess; index += 1) {
      this.entries.delete(ordered[index][0]);
    }
  }
}

export type RateLimitStoreKind = "memory" | "postgres";

export function resolveStoreKind(): RateLimitStoreKind {
  return process.env.RATE_LIMIT_STORE === "postgres" ? "postgres" : "memory";
}

/**
 * Persistent-store seam. The in-memory store is per Cloud Run instance, so with
 * max_instance_count 10 the effective ceiling is 10x the policy and every scale-to-zero
 * resets it. A follow-up phase implements a Postgres-backed RateLimitStore behind this
 * factory; no call site changes when it lands. See openIssues for the required model.
 */
export function createRateLimitStore(
  kind: RateLimitStoreKind = resolveStoreKind(),
): RateLimitStore {
  if (kind === "postgres") {
    throw new Error("RATE_LIMIT_STORE_NOT_IMPLEMENTED:postgres");
  }
  return new MemoryRateLimitStore();
}

let activeStore: RateLimitStore = new MemoryRateLimitStore();

export function getRateLimitStore(): RateLimitStore {
  return activeStore;
}

export function setRateLimitStore(store: RateLimitStore): void {
  activeStore = store;
}

export function resetRateLimitStore(): void {
  activeStore = new MemoryRateLimitStore();
}

export type RateLimitResult = {
  allowed: boolean;
  policy: RateLimitPolicyName;
  key: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

export type EnforceRateLimitOptions = {
  store?: RateLimitStore;
  now?: number;
};

export function rateLimitKey(policy: RateLimitPolicyName, identifier: string): string {
  return `${policy}:${identifier}`;
}

export async function enforceRateLimit(
  policy: RateLimitPolicyName,
  identifier: string,
  options: EnforceRateLimitOptions = {},
): Promise<RateLimitResult> {
  const definition = RATE_LIMIT_POLICIES[policy];
  const ceiling = effectiveLimit(definition);
  const store = options.store ?? getRateLimitStore();
  const now = options.now ?? Date.now();
  const key = rateLimitKey(policy, identifier);
  const entry = await store.increment(key, definition.windowMs, now);
  const allowed = entry.count <= ceiling;

  return {
    allowed,
    policy,
    key,
    limit: ceiling,
    used: entry.count,
    remaining: Math.max(0, ceiling - entry.count),
    resetAt: entry.resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

export function rateLimitHeaders(
  result: RateLimitResult,
  now: number = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(Math.max(0, Math.ceil((result.resetAt - now) / 1000))),
    "RateLimit-Policy": `${result.limit};w=${Math.round(
      RATE_LIMIT_POLICIES[result.policy].windowMs / 1000,
    )}`,
  };
  if (!result.allowed) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}

const LEGACY_WINDOW_MS = 60_000;
const LEGACY_MAX_REQUESTS = 30;
const legacyStore = new MemoryRateLimitStore();

/**
 * @deprecated Compatibility shim preserving the pre-hardening 30 req / 60 s behaviour for
 * the two call sites that have not been migrated to `apiRoute` yet. It keys on whatever
 * the caller passes, which today is a spoofable raw x-forwarded-for header. Delete this
 * together with the last `checkRateLimit` import.
 */
export function checkRateLimit(key: string): boolean {
  return legacyStore.incrementSync(key, LEGACY_WINDOW_MS).count <= LEGACY_MAX_REQUESTS;
}
