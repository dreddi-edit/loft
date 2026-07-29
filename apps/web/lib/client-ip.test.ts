import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRUSTED_HOPS,
  UNKNOWN_CLIENT_IP,
  getClientIp,
  getClientIpKey,
  getTrustedHops,
  normalizeIp,
  parseForwardedFor,
  resolveClientIp,
  toRateLimitKey,
} from "./client-ip";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeIp", () => {
  it("accepts plain IPv4 and IPv6", () => {
    expect(normalizeIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
  });

  it("strips ports, brackets and zone identifiers", () => {
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  it("unwraps IPv4-mapped IPv6 so both spellings share a bucket", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("rejects obfuscated and malformed identifiers", () => {
    expect(normalizeIp("unknown")).toBeNull();
    expect(normalizeIp("_hidden")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp("not-an-ip")).toBeNull();
  });
});

describe("parseForwardedFor", () => {
  it("splits the list and drops entries that are not addresses", () => {
    expect(parseForwardedFor("unknown, 203.0.113.7, 35.191.10.1")).toEqual([
      "203.0.113.7",
      "35.191.10.1",
    ]);
  });

  it("returns an empty chain for a missing header", () => {
    expect(parseForwardedFor(null)).toEqual([]);
  });
});

describe("resolveClientIp spoofing scenarios", () => {
  it("uses the second-from-last hop on Cloud Run behind a global load balancer", () => {
    const result = resolveClientIp(headers({ "x-forwarded-for": "203.0.113.7, 35.191.10.1" }), {
      trustedHops: 1,
    });
    expect(result.ip).toBe("203.0.113.7");
    expect(result.source).toBe("forwarded-for");
    expect(result.trusted).toBe(true);
  });

  it("ignores a client-supplied leftmost value", () => {
    const spoofed = resolveClientIp(
      headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 35.191.10.1" }),
      { trustedHops: 1 },
    );
    expect(spoofed.ip).toBe("203.0.113.7");
    expect(spoofed.ip).not.toBe("9.9.9.9");
  });

  it("keys an attacker rotating the leftmost value into a single bucket", () => {
    const keys = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3", "203.0.113.250"].map(
        (forged) =>
          resolveClientIp(headers({ "x-forwarded-for": `${forged}, 203.0.113.7, 35.191.10.1` }), {
            trustedHops: 1,
          }).key,
      ),
    );
    expect([...keys]).toEqual(["203.0.113.7"]);
  });

  it("does not let extra forged hops push the real client out of the window", () => {
    const result = resolveClientIp(
      headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7, 35.191.10.1" }),
      { trustedHops: 1 },
    );
    expect(result.ip).toBe("203.0.113.7");
  });

  it("falls back to the rightmost hop, never the leftmost, when the chain is too short", () => {
    const result = resolveClientIp(headers({ "x-forwarded-for": "9.9.9.9" }), { trustedHops: 1 });
    expect(result.ip).toBe("9.9.9.9");
    expect(result.trusted).toBe(false);
  });

  it("reads the only hop when no proxy is trusted", () => {
    const result = resolveClientIp(headers({ "x-forwarded-for": "203.0.113.7" }), {
      trustedHops: 0,
    });
    expect(result.ip).toBe("203.0.113.7");
    expect(result.trusted).toBe(true);
  });

  it("supports deeper trusted chains such as Cloudflare in front of the load balancer", () => {
    const result = resolveClientIp(
      headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 172.70.1.1, 35.191.10.1" }),
      { trustedHops: 2 },
    );
    expect(result.ip).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip and then to a constant", () => {
    expect(resolveClientIp(headers({ "x-real-ip": "203.0.113.7" })).ip).toBe("203.0.113.7");
    expect(resolveClientIp(headers({})).ip).toBe(UNKNOWN_CLIENT_IP);
    expect(getClientIp(headers({}))).toBe(UNKNOWN_CLIENT_IP);
  });

  it("reads the hop count from RATE_LIMIT_TRUSTED_HOPS", () => {
    expect(getTrustedHops()).toBe(DEFAULT_TRUSTED_HOPS);
    vi.stubEnv("RATE_LIMIT_TRUSTED_HOPS", "2");
    expect(getTrustedHops()).toBe(2);
    expect(
      getClientIp(headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 1.1.1.1, 2.2.2.2" })),
    ).toBe("203.0.113.7");
    vi.stubEnv("RATE_LIMIT_TRUSTED_HOPS", "not-a-number");
    expect(getTrustedHops()).toBe(DEFAULT_TRUSTED_HOPS);
    vi.stubEnv("RATE_LIMIT_TRUSTED_HOPS", "-3");
    expect(getTrustedHops()).toBe(DEFAULT_TRUSTED_HOPS);
  });
});

describe("toRateLimitKey", () => {
  it("keeps IPv4 addresses verbatim", () => {
    expect(toRateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(toRateLimitKey(UNKNOWN_CLIENT_IP)).toBe(UNKNOWN_CLIENT_IP);
  });

  it("collapses IPv6 addresses to their /64 so host rotation cannot escape the bucket", () => {
    const first = toRateLimitKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    const second = toRateLimitKey("2001:db8:1234:5678:1111:2222:3333:4444");
    expect(first).toBe("2001:db8:1234:5678::/64");
    expect(second).toBe(first);
    expect(toRateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("collapses through the resolver as well", () => {
    const key = getClientIpKey(
      headers({ "x-forwarded-for": "::1, 2001:db8:1234:5678::5, 35.191.10.1" }),
      { trustedHops: 1 },
    );
    expect(key).toBe("2001:db8:1234:5678::/64");
  });
});
