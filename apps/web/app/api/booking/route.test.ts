import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeMessageForCode } from "../../../lib/api-errors";
import {
  REQUEST_ID_HEADER,
  resetApiLogSink,
  setApiLogSink,
  type LogRecord,
} from "../../../lib/api-handler";
import { RATE_LIMIT_POLICIES, effectiveLimit, resetRateLimitStore } from "../../../lib/rate-limit";

const createBooking = vi.fn();
const sendBookingConfirmation = vi.fn();
const createAppointmentAccessToken = vi.fn();

vi.mock("@hair-simo/core", () => ({
  BookingService: class {
    createBooking = createBooking;
  },
  NotificationService: class {
    sendBookingConfirmation = sendBookingConfirmation;
  },
  createAppointmentAccessToken: (...args: unknown[]) => createAppointmentAccessToken(...args),
  formatSalonTimeRange: () => "01.08.2026, 09:00 - 10:00",
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const APPOINTMENT = {
  id: "apt_1",
  customerId: "cus_1",
  status: "pending",
  startsAt: "2026-08-01T07:00:00.000Z",
  endsAt: "2026-08-01T08:00:00.000Z",
  customer: { email: "guest@example.com" },
};

const VALID_BODY = {
  serviceSlug: "damen-schnitt",
  startsAt: "2026-08-01T07:00:00.000Z",
  customerEmail: "guest@example.com",
  locale: "de",
  termsAccepted: true,
};

let logs: LogRecord[] = [];

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hairsimo.it/api/booking", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  createBooking.mockReset();
  sendBookingConfirmation.mockReset();
  createAppointmentAccessToken.mockReset();
  createBooking.mockResolvedValue(APPOINTMENT);
  createAppointmentAccessToken.mockResolvedValue("tok_manage");
  sendBookingConfirmation.mockResolvedValue({ delivery: { status: "sent" } });
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/booking", () => {
  it("creates a booking and returns a manage link but never the bare token", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://hairsimo.it");
    const response = await POST(jsonRequest(VALID_BODY));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.id).toBe("apt_1");
    expect(body.data.manageUrl).toBe("https://hairsimo.it/de/manage/tok_manage");
    expect(body.data.confirmation).toEqual({ requested: true, status: "sent" });
    expect(body.data).not.toHaveProperty("manageToken");
    expect(body.data).not.toHaveProperty("token");
  });

  it("rejects a booking that does not accept the terms", async () => {
    const response = await POST(jsonRequest({ ...VALID_BODY, termsAccepted: false }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.details[0].path).toBe("termsAccepted");
    expect(createBooking).not.toHaveBeenCalled();
  });

  it("returns 400 with field-level detail and never echoes the submitted values", async () => {
    const response = await POST(
      jsonRequest({
        serviceSlug: "",
        startsAt: "not-a-date",
        customerEmail: "definitely-not-an-email",
        termsAccepted: true,
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toBe(safeMessageForCode("VALIDATION_ERROR"));
    expect(body.details.map((detail: { path: string }) => detail.path).sort()).toEqual([
      "customerEmail",
      "serviceSlug",
      "startsAt",
    ]);
    expect(JSON.stringify(body)).not.toContain("definitely-not-an-email");
  });

  it("bounds every unbounded string so a booking cannot carry a payload", async () => {
    const response = await POST(
      jsonRequest({
        ...VALID_BODY,
        customerFirstName: "a".repeat(101),
        customerPhone: "9".repeat(31),
      }),
    );
    expect(response.status).toBe(400);
    expect(
      (await response.json()).details.map((detail: { path: string }) => detail.path).sort(),
    ).toEqual(["customerFirstName", "customerPhone"]);
  });

  it("returns 413 for an oversized body before the booking service is reached", async () => {
    const response = await POST(jsonRequest({ ...VALID_BODY, note: "x".repeat(9_000) }));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(createBooking).not.toHaveBeenCalled();
  });

  it("rejects a content type the route does not accept", async () => {
    const response = await POST(
      new NextRequest("https://hairsimo.it/api/booking", {
        method: "POST",
        headers: { "content-type": "application/xml" },
        body: "<booking/>",
      }),
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 429 with Retry-After once the booking policy is exceeded", async () => {
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.booking);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await POST(jsonRequest(VALID_BODY))).status).toBe(201);
    }
    const blocked = await POST(jsonRequest(VALID_BODY));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("translates a taken slot into 409 SLOT_NOT_AVAILABLE", async () => {
    createBooking.mockRejectedValue(new Error("SLOT_NOT_AVAILABLE"));
    const response = await POST(jsonRequest(VALID_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "SLOT_NOT_AVAILABLE",
      message: safeMessageForCode("SLOT_NOT_AVAILABLE"),
    });
  });

  it("translates a lead-time refusal into a safe explanation", async () => {
    createBooking.mockRejectedValue(new Error("BOOKING_TOO_SOON"));
    const response = await POST(jsonRequest(VALID_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "SLOT_NOT_AVAILABLE",
      message: "This time is too close to now to be booked online. Please call the salon.",
    });
  });

  it("never leaks a database failure to the client", async () => {
    createBooking.mockRejectedValue(
      new Error(
        "Invalid `prisma.appointment.create()` invocation in /app/packages/db/src/index.ts:41 " +
          "Unique constraint failed on the fields: (`staffId`,`startsAt`)",
      ),
    );

    const response = await POST(jsonRequest(VALID_BODY));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("prisma");
    expect(encoded).not.toContain("Unique constraint");
    expect(encoded).not.toContain("/app/packages");
    expect(String(logs.at(-1)?.error)).toContain("Unique constraint");
  });

  it("still returns 201 when the confirmation email fails after the row is committed", async () => {
    sendBookingConfirmation.mockRejectedValue(new Error("SMTP 421 service not available"));

    const response = await POST(jsonRequest(VALID_BODY));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.confirmation).toEqual({ requested: true, status: "failed" });
    expect(JSON.stringify(body)).not.toContain("SMTP 421");
  });

  it("still returns 201 when the manage token cannot be minted", async () => {
    createAppointmentAccessToken.mockRejectedValue(new Error("APPOINTMENT_TOKEN_SECRET_MISSING"));

    const response = await POST(jsonRequest(VALID_BODY));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.manageUrl).toBeNull();
    expect(JSON.stringify(body)).not.toContain("APPOINTMENT_TOKEN_SECRET_MISSING");
  });
});

describe("routes deleted by the security audit stay deleted", () => {
  it.each([
    "booking/[id]/cancel",
    "booking/[id]/reschedule",
    "notifications/reminder",
  ])("has no module at /api/%s", (route) => {
    const dir = path.join(API_DIR, ...route.split("/"));
    expect(existsSync(dir)).toBe(false);
    for (const extension of ["ts", "tsx", "js", "jsx"]) {
      expect(existsSync(path.join(dir, `route.${extension}`))).toBe(false);
    }
  });

  it("keeps every appointment mutation behind the token route", () => {
    expect(existsSync(path.join(API_DIR, "appointment", "[token]", "route.ts"))).toBe(true);
    expect(existsSync(path.join(API_DIR, "booking", "[id]"))).toBe(false);
  });
});
