import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appointmentFindUnique } = vi.hoisted(() => ({ appointmentFindUnique: vi.fn() }));

vi.mock("@hair-simo/db", () => ({

  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({ tenantId_email: { tenantId: "cltenant00000000000000001", email } }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({ tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek } }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },

  runWithTenantAsync: async (_ctx: unknown, fn: () => unknown) => fn(),
  prisma: {
    tenant: { findUnique: async () => ({ id: "cltenant00000000000000001", slug: "hairsimo-brixen", displayName: "Hair Simo", timeZone: "Europe/Rome", defaultLocale: "it", status: "active", settings: {} }) }, appointment: { findUnique: appointmentFindUnique } },
}));

import { createAppointmentAccessToken } from "@hair-simo/core";
import { safeMessageForCode } from "../../../../../lib/api-errors";
import { resetApiLogSink, setApiLogSink, type LogRecord } from "../../../../../lib/api-handler";
import {
  RATE_LIMIT_POLICIES,
  effectiveLimit,
  resetRateLimitStore,
} from "../../../../../lib/rate-limit";
import { GET } from "./route";

const TOKEN_SECRET = "9d2f7a1c4e8b0d3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f";
const OTHER_SECRET = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const APPOINTMENT_ID = "appt1";
const CUSTOMER_ID = "cus1";
const STAFF_NOTE = "Kundin zahlt immer bar und kommt zu spaet";

const appointmentRow = {
  id: APPOINTMENT_ID,
  customerId: CUSTOMER_ID,
  startsAt: new Date("2026-08-04T06:00:00.000Z"),
  endsAt: new Date("2026-08-04T07:15:00.000Z"),
  locale: "de",
  status: "confirmed",
  notes: STAFF_NOTE,
  cancellationReason: null,
  createdAt: new Date("2026-07-20T09:00:00.000Z"),
  updatedAt: new Date("2026-07-20T09:00:00.000Z"),
  service: { slug: "cut", translations: [{ locale: "de", name: "Haarschnitt" }] },
  staff: { displayName: "Simona" },
  customer: {
    firstName: "Anna",
    lastName: "Müller",
    email: "anna@example.com",
    deletedAt: null,
    anonymizedAt: null,
  },
};

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  setApiLogSink((record) => logs.push(record));
  resetRateLimitStore();
  vi.stubEnv("APPOINTMENT_TOKEN_SECRET", TOKEN_SECRET);
  appointmentFindUnique.mockResolvedValue(appointmentRow);
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function call(token: string, method = "GET"): Promise<Response> {
  const request = new NextRequest(`https://hairsimo.it/api/calendar/appointment/${token}`, {
    method,
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
  return GET(request, { params: Promise.resolve({ token }) });
}

function validToken(): Promise<string> {
  return createAppointmentAccessToken({
    appointmentId: APPOINTMENT_ID,
    customerId: CUSTOMER_ID,
    startsAt: appointmentRow.startsAt,
  });
}

describe("GET /api/calendar/appointment/[token] success", () => {
  it("returns the invitation as raw iCalendar rather than the JSON envelope", async () => {
    const response = await call(await validToken());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="hair-simo-${APPOINTMENT_ID}.ics"`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("METHOD:REQUEST");
    expect(body).toContain(`UID:${APPOINTMENT_ID}@hairsimo.it`);
    expect(() => JSON.parse(body)).toThrow();
  });

  it("accepts the .ics suffix a mail client may append to the link", async () => {
    const response = await call(`${await validToken()}.ics`);
    expect(response.status).toBe(200);
    expect((await response.text()).startsWith("BEGIN:VCALENDAR")).toBe(true);
  });

  it("keeps the back-office note out of the customer's calendar entry", async () => {
    const body = await (await call(await validToken())).text();
    expect(body).not.toContain("bar und kommt");
    expect(body).toContain("Haarschnitt");
  });

  it("answers a cancelled appointment with METHOD:CANCEL under the same uid", async () => {
    appointmentFindUnique.mockResolvedValue({
      ...appointmentRow,
      status: "cancelled",
      cancellationReason: "customer request",
    });

    const body = await (await call(await validToken())).text();
    expect(body).toContain("METHOD:CANCEL");
    expect(body).toContain("STATUS:CANCELLED");
    expect(body).toContain(`UID:${APPOINTMENT_ID}@hairsimo.it`);
  });
});

describe("GET /api/calendar/appointment/[token] auth boundary", () => {
  it("rejects a token that is not a token", async () => {
    const response = await call("not-a-token");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: "This appointment link is invalid or has expired.",
    });
    expect(appointmentFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a token signed with a different secret", async () => {
    vi.stubEnv("APPOINTMENT_TOKEN_SECRET", OTHER_SECRET);
    const forged = await validToken();
    vi.stubEnv("APPOINTMENT_TOKEN_SECRET", TOKEN_SECRET);

    const response = await call(forged);
    expect(response.status).toBe(401);
    expect(appointmentFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a token bound to a different customer than the appointment row", async () => {
    const token = await createAppointmentAccessToken({
      appointmentId: APPOINTMENT_ID,
      customerId: "cus-somebody-else",
    });

    const response = await call(token);
    expect(response.status).toBe(401);
    expect(await (await call(token)).text()).not.toContain("BEGIN:VCALENDAR");
  });

  it("reports a vanished appointment as not found, not as a server error", async () => {
    appointmentFindUnique.mockResolvedValue(null);
    const response = await call(await validToken());
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("APPOINTMENT_NOT_FOUND");
  });

  it("rejects an oversized path segment before verifying anything", async () => {
    const response = await call("a".repeat(3_000));
    expect(response.status).toBe(401);
    expect(appointmentFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a method outside the allowlist", async () => {
    const response = await call(await validToken(), "POST");
    expect(response.status).toBe(405);
  });

  it("never returns a raw failure to the customer", async () => {
    const leak = "Invalid `prisma.appointment.findUnique()` invocation: connection refused";
    appointmentFindUnique.mockRejectedValue(new Error(leak));

    const response = await call(await validToken());
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain(safeMessageForCode("INTERNAL"));
    expect(body).not.toContain("prisma");
    expect(String(logs.at(-1)?.error)).toContain("connection refused");
  });

  it("rate limits the enumerable link so it cannot be polled without bound", async () => {
    const token = await validToken();
    const ceiling = effectiveLimit(RATE_LIMIT_POLICIES.availability);
    for (let index = 0; index < ceiling; index += 1) {
      expect((await call(token)).status).toBe(200);
    }
    expect((await call(token)).status).toBe(429);
  });
});
