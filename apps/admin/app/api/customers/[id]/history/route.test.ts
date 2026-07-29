import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_ID_HEADER,
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  safeMessageForCode,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../../lib/admin-api";

const getCustomerProfile = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "staff@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  CustomerHistoryService: vi.fn().mockImplementation(() => ({
    getCustomerProfile: (...args: unknown[]) => getCustomerProfile(...args),
  })),
  salonRepository: { createAuditLog: vi.fn() },
}));

const { GET } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const PROFILE = {
  customer: {
    id: "cus_1",
    firstName: "Anna",
    lastName: "Bianchi",
    email: "anna@example.com",
    phone: null,
    locale: "de",
    marketingOptIn: false,
    customerSince: new Date("2024-01-15T10:00:00.000Z"),
    customerSinceLabel: "15 Jan 2024, 11:00",
  },
  hasAllergies: false,
  allergies: [],
  pinned: [],
  notes: [],
  noteCounts: { total: 0, general: 0, formula: 0, allergy: 0, preference: 0 },
  latestFormula: null,
  formulaHistory: [],
  preferredStaff: null,
  preferredService: null,
  stats: {
    visitCount: 3,
    upcomingCount: 0,
    cancelledCount: 0,
    noShowCount: 0,
    noShowRate: 0,
    lifetimeValueCents: 12000,
    paidOnlineCents: 0,
    tipsCents: 0,
    currency: "EUR" as const,
    averageIntervalDays: null,
    daysSinceLastVisit: null,
    dueForRebooking: false,
    firstVisitAt: null,
    lastVisitAt: null,
    lastVisitLabel: null,
    nextAppointmentAt: null,
    nextAppointmentLabel: null,
  },
  lastVisit: null,
  nextAppointment: null,
  recentVisits: [],
  windowMonths: 24,
  generatedAt: new Date("2026-07-29T12:00:00.000Z"),
};

let audits: AuditEntry[] = [];

function context(id = "cus_1") {
  return { params: Promise.resolve({ id }) };
}

function getRequest(role: string | null = "staff", locale = "de"): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/customers/cus_1/history?locale=${locale}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

beforeEach(() => {
  audits = [];
  setAdminApiLogSink(() => {});
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  resetAdminRateLimits();
  requireSession.mockClear();
  getCustomerProfile.mockReset();
  getCustomerProfile.mockResolvedValue(PROFILE);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/customers/[id]/history", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    const anonymous = await GET(getRequest(null), context());
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error).toBe("UNAUTHORIZED");

    const wrongRole = await GET(getRequest("customer"), context());
    expect(wrongRole.status).toBe(403);
    expect((await wrongRole.json()).error).toBe("FORBIDDEN");
    expect(getCustomerProfile).not.toHaveBeenCalled();
  });

  it("returns the customer profile with the requested locale", async () => {
    const response = await GET(getRequest("staff", "de"), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.customer.id).toBe("cus_1");
    expect(getCustomerProfile).toHaveBeenCalledExactlyOnceWith("cus_1", { locale: "de" });
    expect(audits).toHaveLength(0);
  });

  it("returns 404 with a safe message for an unknown customer", async () => {
    getCustomerProfile.mockRejectedValue(new Error("CUSTOMER_NOT_FOUND"));
    const response = await GET(getRequest("staff"), context("cus_missing"));
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: "NOT_FOUND",
      message: safeMessageForCode("NOT_FOUND"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("cus_missing");
  });
});
