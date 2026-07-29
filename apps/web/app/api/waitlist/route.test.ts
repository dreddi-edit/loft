import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  join: vi.fn(),
  findServiceBySlug: vi.fn(),
  findOrCreateCustomerByEmail: vi.fn(),
  recordConsent: vi.fn(),
}));

vi.mock("@hair-simo/core", () => {
  class WaitlistError extends Error {
    readonly code: string;

    constructor(code: string, detail?: string) {
      super(detail ? `${code}: ${detail}` : code);
      this.name = "WaitlistError";
      this.code = code;
    }
  }

  return {
    WaitlistError,
    WaitlistService: class {
      join = mocks.join;
    },
    salonRepository: {
      findServiceBySlug: mocks.findServiceBySlug,
      findOrCreateCustomerByEmail: mocks.findOrCreateCustomerByEmail,
      recordConsent: mocks.recordConsent,
    },
  };
});

import { WaitlistError } from "@hair-simo/core";
import { REQUEST_ID_HEADER, resetApiLogSink, setApiLogSink } from "../../../lib/api-handler";
import { RATE_LIMIT_POLICIES, effectiveLimit, resetRateLimitStore } from "../../../lib/rate-limit";
import { POST } from "./route";

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const SERVICE = { id: "svc_cut", slug: "cut", isActive: true, durationMin: 60 };
const CUSTOMER = { id: "cus_1", email: "maria@example.com" };

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    serviceSlug: "cut",
    earliestAt: "2026-08-03T07:00:00.000Z",
    latestAt: "2026-08-03T15:00:00.000Z",
    customerEmail: "maria@example.com",
    customerFirstName: "Maria",
    locale: "it",
    termsAccepted: true,
    ...overrides,
  };
}

function request(body: unknown, init: { method?: string } = {}): NextRequest {
  const method = init.method ?? "POST";
  return new NextRequest("https://hairsimo.it/api/waitlist", {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": CLOUD_RUN_CHAIN },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  mocks.join.mockReset();
  mocks.findServiceBySlug.mockReset();
  mocks.findOrCreateCustomerByEmail.mockReset();
  mocks.recordConsent.mockReset();

  mocks.findServiceBySlug.mockResolvedValue(SERVICE);
  mocks.findOrCreateCustomerByEmail.mockResolvedValue(CUSTOMER);
  mocks.recordConsent.mockResolvedValue({ id: "consent_1" });
  mocks.join.mockResolvedValue({
    entry: { id: "wl_1", status: "active" },
    created: true,
    heldAppointmentIds: [],
  });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
});

describe("POST /api/waitlist", () => {
  it("queues the customer against the resolved service and records the consent", async () => {
    const response = await POST(request(validBody({ staffId: "stf_1", channel: "sms" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        status: "queued",
        serviceSlug: "cut",
        earliestAt: "2026-08-03T07:00:00.000Z",
        latestAt: "2026-08-03T15:00:00.000Z",
      },
    });

    expect(mocks.findOrCreateCustomerByEmail).toHaveBeenCalledWith(
      "maria@example.com",
      "it",
      "sms",
      { firstName: "Maria", lastName: undefined, phone: undefined },
    );
    expect(mocks.recordConsent).toHaveBeenCalledWith(CUSTOMER.id, "terms", true, "waitlist");
    expect(mocks.join).toHaveBeenCalledWith({
      customerId: "cus_1",
      serviceId: "svc_cut",
      staffId: "stf_1",
      earliestAt: "2026-08-03T07:00:00.000Z",
      latestAt: "2026-08-03T15:00:00.000Z",
      locale: "it",
      channel: "sms",
    });
  });

  it("answers a deduplicated join exactly like a fresh one", async () => {
    const fresh = await (await POST(request(validBody()))).json();

    resetRateLimitStore();
    mocks.join.mockResolvedValue({
      entry: { id: "wl_existing", status: "notified" },
      created: false,
      duplicateOf: "wl_existing",
      heldAppointmentIds: ["apt_9"],
    });
    const deduplicated = await POST(request(validBody()));
    const body = await deduplicated.json();

    expect(deduplicated.status).toBe(200);
    expect(body).toEqual(fresh);
    expect(JSON.stringify(body)).not.toContain("apt_9");
    expect(JSON.stringify(body)).not.toContain("wl_existing");
    expect(JSON.stringify(body)).not.toContain("cus_1");
  });

  it("refuses an unknown or inactive service before touching the customer table", async () => {
    mocks.findServiceBySlug.mockResolvedValue(null);
    const missing = await POST(request(validBody({ serviceSlug: "nope" })));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("SERVICE_NOT_FOUND");

    resetRateLimitStore();
    mocks.findServiceBySlug.mockResolvedValue({ ...SERVICE, isActive: false });
    const inactive = await POST(request(validBody()));
    expect(inactive.status).toBe(404);

    expect(mocks.findOrCreateCustomerByEmail).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied customerId instead of trusting it", async () => {
    const response = await POST(request(validBody({ customerId: "cus_victim" })));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(mocks.findOrCreateCustomerByEmail).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("rejects a join without accepted terms and a non-instant window", async () => {
    const noTerms = await POST(request(validBody({ termsAccepted: false })));
    expect(noTerms.status).toBe(400);

    resetRateLimitStore();
    const badWindow = await POST(request(validBody({ earliestAt: "next tuesday" })));
    expect(badWindow.status).toBe(400);
    expect((await badWindow.json()).details[0].path).toBe("earliestAt");

    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("bounds every free-text field", async () => {
    const response = await POST(
      request(validBody({ customerFirstName: "x".repeat(101), serviceSlug: "y".repeat(101) })),
    );
    expect(response.status).toBe(400);
    expect(
      (await response.json()).details.map((detail: { path: string }) => detail.path).sort(),
    ).toEqual(["customerFirstName", "serviceSlug"]);
  });

  it("maps window failures onto 400 and the entry cap onto 409", async () => {
    mocks.join.mockRejectedValue(new WaitlistError("WINDOW_IN_PAST"));
    const past = await POST(request(validBody()));
    expect(past.status).toBe(400);
    expect(await past.json()).toMatchObject({
      error: "VALIDATION_ERROR",
      message: "The requested window has already passed.",
    });

    resetRateLimitStore();
    mocks.join.mockRejectedValue(new WaitlistError("TOO_MANY_WAITLIST_ENTRIES"));
    const tooMany = await POST(request(validBody()));
    expect(tooMany.status).toBe(409);
    expect((await tooMany.json()).error).toBe("CONFLICT");

    resetRateLimitStore();
    mocks.join.mockRejectedValue(new WaitlistError("STAFF_NOT_ELIGIBLE"));
    const staff = await POST(request(validBody({ staffId: "stf_2" })));
    expect(staff.status).toBe(409);
    expect((await staff.json()).error).toBe("STAFF_NOT_ELIGIBLE");
  });

  it("gives an erased customer a neutral answer", async () => {
    mocks.findOrCreateCustomerByEmail.mockRejectedValue(new Error("CUSTOMER_ANONYMIZED"));
    const response = await POST(request(validBody()));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toBe(
      "This email address cannot be added to the waitlist. Please contact the salon.",
    );
    expect(JSON.stringify(body)).not.toContain("ANONYMIZED");
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("never leaks a configuration failure", async () => {
    mocks.join.mockRejectedValue(new WaitlistError("OFFER_SECRET_MISSING"));
    const response = await POST(request(validBody()));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: "An unexpected error occurred. Please try again later.",
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("OFFER_SECRET_MISSING");
  });

  it("rate limits the write it performs for an unauthenticated caller", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.booking);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(request(validBody()))).status).toBe(200);
    }

    const blocked = await POST(request(validBody()));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
    expect(mocks.join).toHaveBeenCalledTimes(ceiling);
  });

  it("refuses methods other than POST", async () => {
    const response = await POST(request(validBody(), { method: "GET" }));
    expect(response.status).toBe(405);
  });
});
