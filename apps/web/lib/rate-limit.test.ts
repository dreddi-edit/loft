import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRateLimitStore,
  RATE_LIMIT_POLICIES,
  checkRateLimit,
  createRateLimitStore,
  effectiveLimit,
  enforceRateLimit,
  getRateLimitStore,
  rateLimitHeaders,
  rateLimitKey,
  resetRateLimitStore,
  resolveStoreKind,
  setRateLimitStore,
  type RateLimitStore,
} from "./rate-limit";

beforeEach(() => {
  resetRateLimitStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimitStore();
});

describe("policies", () => {
  it("expresses a limit and window for every expensive endpoint class", () => {
    for (const [name, policy] of Object.entries(RATE_LIMIT_POLICIES)) {
      expect(policy.limit, name).toBeGreaterThan(0);
      expect(policy.windowMs, name).toBeGreaterThan(0);
      expect(effectiveLimit(policy), name).toBeGreaterThanOrEqual(policy.limit);
    }
  });

  it("keeps the expensive GCP-backed policies tighter than public reads", () => {
    const perMinute = (name: keyof typeof RATE_LIMIT_POLICIES) => {
      const policy = RATE_LIMIT_POLICIES[name];
      return (effectiveLimit(policy) / policy.windowMs) * 60_000;
    };
    expect(perMinute("voice")).toBeLessThan(perMinute("publicRead"));
    expect(perMinute("chat")).toBeLessThan(perMinute("publicRead"));
    expect(perMinute("contact")).toBeLessThan(perMinute("booking"));
  });
});

describe("enforceRateLimit", () => {
  it("allows up to limit + burst and then blocks", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);
    const results = [];
    for (let index = 0; index < ceiling + 1; index += 1) {
      results.push(await enforceRateLimit("contact", "203.0.113.7", { now: 1_000 }));
    }
    expect(results.slice(0, ceiling).every((result) => result.allowed)).toBe(true);
    expect(results[ceiling].allowed).toBe(false);
    expect(results[ceiling].remaining).toBe(0);
    expect(results[0].remaining).toBe(ceiling - 1);
    expect(results[ceiling].retryAfterSeconds).toBe(
      Math.ceil(RATE_LIMIT_POLICIES.contact.windowMs / 1000),
    );
  });

  it("isolates buckets per policy and per identifier", async () => {
    await enforceRateLimit("contact", "a", { now: 0 });
    const other = await enforceRateLimit("contact", "b", { now: 0 });
    const otherPolicy = await enforceRateLimit("booking", "a", { now: 0 });
    expect(other.used).toBe(1);
    expect(otherPolicy.used).toBe(1);
    expect(rateLimitKey("contact", "a")).toBe("contact:a");
  });

  it("rolls the window over once resetAt has passed", async () => {
    const window = RATE_LIMIT_POLICIES.contact.windowMs;
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);
    for (let index = 0; index < ceiling; index += 1) {
      await enforceRateLimit("contact", "203.0.113.7", { now: 1_000 });
    }
    const blocked = await enforceRateLimit("contact", "203.0.113.7", { now: 1_000 });
    expect(blocked.allowed).toBe(false);

    const stillBlocked = await enforceRateLimit("contact", "203.0.113.7", {
      now: 1_000 + window - 1,
    });
    expect(stillBlocked.allowed).toBe(false);

    const fresh = await enforceRateLimit("contact", "203.0.113.7", { now: 1_000 + window });
    expect(fresh.allowed).toBe(true);
    expect(fresh.used).toBe(1);
    expect(fresh.resetAt).toBe(1_000 + window * 2);
  });

  it("keeps counting rejected requests so hammering does not reopen the window", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.contact);
    for (let index = 0; index < ceiling + 5; index += 1) {
      await enforceRateLimit("contact", "203.0.113.7", { now: 0 });
    }
    const result = await enforceRateLimit("contact", "203.0.113.7", { now: 0 });
    expect(result.used).toBe(ceiling + 6);
    expect(result.allowed).toBe(false);
  });
});

describe("rateLimitHeaders", () => {
  it("emits RateLimit-* on success and adds Retry-After when blocked", async () => {
    const allowed = await enforceRateLimit("booking", "203.0.113.7", { now: 0 });
    const okHeaders = rateLimitHeaders(allowed, 0);
    expect(okHeaders["RateLimit-Limit"]).toBe(String(effectiveLimit(RATE_LIMIT_POLICIES.booking)));
    expect(okHeaders["RateLimit-Reset"]).toBe(String(RATE_LIMIT_POLICIES.booking.windowMs / 1000));
    expect(okHeaders["Retry-After"]).toBeUndefined();

    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.booking);
    for (let index = 0; index < ceiling; index += 1) {
      await enforceRateLimit("booking", "203.0.113.7", { now: 0 });
    }
    const blocked = await enforceRateLimit("booking", "203.0.113.7", { now: 0 });
    expect(rateLimitHeaders(blocked, 0)["Retry-After"]).toBe(String(blocked.retryAfterSeconds));
  });
});

describe("MemoryRateLimitStore", () => {
  it("expires entries lazily on get", async () => {
    const store = new MemoryRateLimitStore();
    await store.increment("a", 100, 0);
    expect(await store.get("a", 50)).toEqual({ count: 1, resetAt: 100 });
    expect(await store.get("a", 100)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("sweeps expired entries so the map cannot grow unbounded", async () => {
    const store = new MemoryRateLimitStore({ sweepIntervalMs: 1_000 });
    store.incrementSync("a", 100, 0);
    store.incrementSync("b", 100, 500);
    expect(store.size).toBe(2);
    store.incrementSync("c", 100, 2_000);
    expect(store.size).toBe(1);
  });

  it("evicts the soonest-expiring entries when maxEntries is exceeded", () => {
    const store = new MemoryRateLimitStore({ maxEntries: 3, sweepIntervalMs: 1_000_000 });
    store.incrementSync("keep-longest", 10_000, 0);
    store.incrementSync("short-1", 10, 0);
    store.incrementSync("short-2", 20, 0);
    store.incrementSync("short-3", 30, 0);
    store.incrementSync("short-4", 40, 0);
    expect(store.size).toBe(3);
    expect(store.incrementSync("keep-longest", 10_000, 1).count).toBe(2);
    expect(store.incrementSync("short-1", 10, 1).count).toBe(1);
  });

  it("resets and clears keys", async () => {
    const store = new MemoryRateLimitStore();
    await store.increment("a", 1_000, 0);
    await store.reset("a");
    expect(await store.get("a", 0)).toBeNull();
    await store.increment("b", 1_000, 0);
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("store seam", () => {
  it("swaps the backing store without touching call sites", async () => {
    const calls: string[] = [];
    const fake: RateLimitStore = {
      async get() {
        return null;
      },
      async increment(key) {
        calls.push(key);
        return { count: 99, resetAt: 5_000 };
      },
      async reset() {},
    };
    setRateLimitStore(fake);
    expect(getRateLimitStore()).toBe(fake);
    const result = await enforceRateLimit("voice", "203.0.113.7", { now: 0 });
    expect(calls).toEqual(["voice:203.0.113.7"]);
    expect(result.allowed).toBe(false);
    expect(result.resetAt).toBe(5_000);
  });

  it("selects the memory store by default and refuses the unimplemented postgres store", () => {
    expect(resolveStoreKind()).toBe("memory");
    expect(createRateLimitStore()).toBeInstanceOf(MemoryRateLimitStore);
    vi.stubEnv("RATE_LIMIT_STORE", "postgres");
    expect(resolveStoreKind()).toBe("postgres");
    expect(() => createRateLimitStore()).toThrow("RATE_LIMIT_STORE_NOT_IMPLEMENTED:postgres");
  });
});

describe("deprecated checkRateLimit shim", () => {
  it("keeps the legacy 30 requests per minute behaviour for unmigrated routes", () => {
    const key = `legacy:${Math.random()}`;
    for (let index = 0; index < 30; index += 1) {
      expect(checkRateLimit(key)).toBe(true);
    }
    expect(checkRateLimit(key)).toBe(false);
  });
});
