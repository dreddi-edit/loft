import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { balanceMock } = vi.hoisted(() => ({ balanceMock: vi.fn() }));

vi.mock("@hair-simo/core", () => ({
  resolveTenantContext: async () => ({
    tenantId: "cltenant00000000000000001",
    slug: "hairsimo-brixen",
    displayName: "Hair Simo",
    timeZone: "Europe/Rome",
    defaultLocale: "it",
  }),
  VoucherService: class {
    balance = balanceMock;
  },
}));

import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink, type LogRecord } from "../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  getRateLimitStore,
  resetRateLimitStore,
} from "../../../../lib/rate-limit";
import { GET } from "./route";

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const CODE = "3479-ABCD-FGHJ";
const CEILING = effectiveLimit(RATE_LIMIT_POLICIES.contact);

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  balanceMock.mockReset();
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
});

function lookup(code: string, ip = "203.0.113.7"): Promise<Response> {
  const url = `https://hairsimo.it/api/vouchers/balance?code=${encodeURIComponent(code)}`;
  return GET(
    new NextRequest(url, {
      method: "GET",
      headers: { "x-forwarded-for": `${ip}, 35.191.10.1` },
    }),
  );
}

function liveVoucher() {
  return {
    code: "3479ABCDFGHJ",
    displayCode: "3479-ABCD-FGHJ",
    initialCents: 10_000,
    remainingCents: 3_500,
    currency: "EUR",
    status: "active" as const,
    expiresAt: new Date("2031-07-29T21:59:59.999Z"),
  };
}

describe("GET /api/vouchers/balance disclosure", () => {
  it("returns the balance and validity and nothing that identifies the card or its buyer", async () => {
    balanceMock.mockResolvedValue(liveVoucher());

    const response = await lookup(CODE);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      data: {
        remainingCents: 3_500,
        currency: "EUR",
        status: "active",
        expiresAt: "2031-07-29T21:59:59.999Z",
      },
    });
    expect(Object.keys(body.data).sort()).toEqual([
      "currency",
      "expiresAt",
      "remainingCents",
      "status",
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("3479ABCDFGHJ");
    expect(serialized).not.toContain("3479-ABCD-FGHJ");
    expect(serialized).not.toContain("10000");
  });

  it("forbids caching so the credentialled answer is not stored by a proxy", async () => {
    balanceMock.mockResolvedValue(liveVoucher());
    const response = await lookup(CODE);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never writes the submitted code into the structured log line", async () => {
    balanceMock.mockResolvedValue(liveVoucher());
    await lookup(CODE);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ route: "/api/vouchers/balance", method: "GET", status: 200 });
    expect(JSON.stringify(logs[0])).not.toContain("3479");
  });

  it("still reports a blocked or expired card to the bearer", async () => {
    balanceMock.mockResolvedValue({ ...liveVoucher(), status: "inactive" });
    const response = await lookup(CODE);
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("inactive");
  });
});

describe("GET /api/vouchers/balance enumeration resistance", () => {
  it("answers a malformed, a mistyped and an unknown code identically", async () => {
    const failures = [
      "VOUCHER_CODE_MALFORMED",
      "VOUCHER_CODE_CHECKSUM_FAILED",
      "VOUCHER_NOT_FOUND",
    ];

    const seen: string[] = [];
    for (const failure of failures) {
      resetRateLimitStore();
      balanceMock.mockRejectedValueOnce(new Error(failure));
      const response = await lookup(CODE);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
      seen.push(JSON.stringify({ ...body, requestId: "<id>" }));
    }

    expect(new Set(seen).size).toBe(1);
    expect(JSON.parse(seen[0])).toEqual({
      error: "NOT_FOUND",
      message: "No voucher matches this code.",
      requestId: "<id>",
    });
  });

  it("caps lookups at the strictest public policy and then answers 429", async () => {
    balanceMock.mockResolvedValue(liveVoucher());

    for (let index = 0; index < CEILING; index += 1) {
      expect((await lookup(CODE)).status).toBe(200);
    }

    const blocked = await lookup(CODE);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(CEILING).toBeLessThanOrEqual(5);
  });

  it("keeps its own bucket so it cannot spend the contact form's allowance", async () => {
    balanceMock.mockResolvedValue(liveVoucher());
    await lookup(CODE);

    const store = getRateLimitStore();
    expect(await store.get("contact:voucher-balance:203.0.113.7")).toMatchObject({ count: 1 });
    expect(await store.get("contact:203.0.113.7")).toBeNull();
  });

  it("throttles per client address rather than globally", async () => {
    balanceMock.mockResolvedValue(liveVoucher());

    for (let index = 0; index < CEILING; index += 1) {
      expect((await lookup(CODE, "203.0.113.7")).status).toBe(200);
    }

    expect((await lookup(CODE, "203.0.113.7")).status).toBe(429);
    expect((await lookup(CODE, "198.51.100.4")).status).toBe(200);
  });

  it("counts a rejected code against the caller's allowance", async () => {
    balanceMock.mockRejectedValue(new Error("VOUCHER_CODE_CHECKSUM_FAILED"));

    for (let index = 0; index < CEILING; index += 1) {
      expect((await lookup(CODE)).status).toBe(404);
    }
    expect((await lookup(CODE)).status).toBe(429);
    expect(balanceMock).toHaveBeenCalledTimes(CEILING);
  });
});

describe("GET /api/vouchers/balance request validation", () => {
  it("rejects a missing code", async () => {
    const response = await GET(
      new NextRequest("https://hairsimo.it/api/vouchers/balance", {
        method: "GET",
        headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(balanceMock).not.toHaveBeenCalled();
  });

  it("bounds the submitted code", async () => {
    const response = await lookup("A".repeat(500));
    expect(response.status).toBe(400);
    expect(balanceMock).not.toHaveBeenCalled();
  });

  it("refuses any method other than GET", async () => {
    const response = await GET(
      new NextRequest("https://hairsimo.it/api/vouchers/balance?code=abc", {
        method: "POST",
        headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
      }),
    );
    expect(response.status).toBe(405);
  });
});

describe("GET /api/vouchers/balance failure handling", () => {
  it("does not disguise an infrastructure failure as an unknown code", async () => {
    const leaky = "Invalid `prisma.voucher.findUnique()` invocation: connection refused";
    balanceMock.mockRejectedValue(new Error(leaky));

    const response = await lookup(CODE);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(String(logs.at(-1)?.error)).toContain("connection refused");
  });
});
