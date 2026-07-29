import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core, db } = vi.hoisted(() => ({
  core: {
    eraseCustomerData: vi.fn(),
    readConsentHistory: vi.fn(),
    listDataRequests: vi.fn(),
    createDataRequest: vi.fn(),
  },
  db: {
    customerFindUnique: vi.fn(),
    dataRequestFindUnique: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  gdprService: {
    eraseCustomerData: core.eraseCustomerData,
    readConsentHistory: core.readConsentHistory,
    listDataRequests: core.listDataRequests,
    createDataRequest: core.createDataRequest,
  },
  salonRepository: { createAuditLog: vi.fn() },
}));

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
    customer: { findUnique: db.customerFindUnique },
    dataRequest: { findUnique: db.dataRequestFindUnique },
  },
}));

vi.mock("../../../../../lib/auth", () => ({
  requireSession: async (request: NextRequest, allowed: RoleKey[]): Promise<AuthSession> => {
    const role = request.headers.get("x-test-role") as RoleKey | null;
    if (!role) throw new Error("UNAUTHENTICATED");
    if (!allowed.includes(role)) throw new Error("FORBIDDEN");
    return { userId: "usr_1", email: `${role}@hairsimo.it`, role, firstName: "S", lastName: "B",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
  },
}));

import {
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
  type LogRecord,
} from "../../../../../lib/admin-api";
import { GET, POST, erasureSchema } from "./route";

const URL = "https://admin.hairsimo.it/api/customers/cus_1/gdpr";
const SUBJECT = {
  email: "anna.bauer@example.com",
  phone: "+393341234567",
  name: "Anna Bauer",
};

let audits: AuditEntry[] = [];
let logs: LogRecord[] = [];

const receipt = {
  schemaVersion: "hair-simo.gdpr.erasure-receipt/1",
  customerId: "cus_1",
  alreadyErased: false,
  requestedBy: "owner@hairsimo.it",
  reason: "subject_request ref:TCK-9",
  identifiers: {
    emailCleared: true,
    phoneCleared: true,
    nameReplaced: true,
    placeholderSuffix: "a1b2c3d4",
  },
  removed: { customerNotesDeleted: 2, messagesRedacted: 14 },
  retained: [
    { dataClass: "payments", records: 3, legalBasis: "DPR 633/1972", retainedFor: "10 years" },
    { dataClass: "appointments", records: 4, legalBasis: "art. 2220", retainedFor: "10 years" },
  ],
};

const erasureBody = {
  confirm: "ERASE",
  customerId: "cus_1",
  reason: "subject_request",
  reference: "TCK-9",
};

function request(
  init: { method?: string; role?: RoleKey | null; body?: unknown } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7" };
  const role = init.role === undefined ? "owner" : init.role;
  if (role !== null) headers["x-test-role"] = role;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(URL, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  audits = [];
  logs = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink((record) => logs.push(record));
  resetAdminRateLimits();
  core.eraseCustomerData.mockReset();
  core.readConsentHistory.mockReset();
  core.listDataRequests.mockReset();
  db.customerFindUnique.mockReset();
  db.dataRequestFindUnique.mockReset();

  db.customerFindUnique.mockResolvedValue({ id: "cus_1", deletedAt: null, anonymizedAt: null });
  core.readConsentHistory.mockResolvedValue({
    customerId: "cus_1",
    marketingOptIn: true,
    marketingFlagDrift: false,
    current: [],
    entries: [],
  });
  core.listDataRequests.mockResolvedValue([]);
  core.eraseCustomerData.mockResolvedValue({
    receipt,
    dataRequestId: "dr_1",
    alreadyErased: false,
  });
});

afterEach(() => {
  resetAdminAuditWriter();
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/customers/[id]/gdpr overview", () => {
  it("rejects an unauthenticated caller and a stylist", async () => {
    expect((await GET(request({ role: null }), context("cus_1"))).status).toBe(401);
    expect((await GET(request({ role: "staff" }), context("cus_1"))).status).toBe(403);
    expect(core.readConsentHistory).not.toHaveBeenCalled();
  });

  it("shows consent history and request history for an erased person too", async () => {
    db.customerFindUnique.mockResolvedValue({
      id: "cus_1",
      deletedAt: new Date("2026-07-01T00:00:00.000Z"),
      anonymizedAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    const response = await GET(request({ role: "manager" }), context("cus_1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.erased).toBe(true);
    expect(body.data.consent.customerId).toBe("cus_1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("404s an unknown customer", async () => {
    db.customerFindUnique.mockResolvedValue(null);
    expect((await GET(request(), context("cus_x"))).status).toBe(404);
  });
});

describe("POST /api/customers/[id]/gdpr erasure authorisation", () => {
  it("refuses a manager at the wrapper, before the body is even read", async () => {
    const response = await POST(
      request({ method: "POST", role: "manager", body: erasureBody }),
      context("cus_1"),
    );

    expect(response.status).toBe(403);
    expect(core.eraseCustomerData).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("refuses a stylist and an unauthenticated caller", async () => {
    expect(
      (await POST(request({ method: "POST", role: "staff", body: erasureBody }), context("cus_1")))
        .status,
    ).toBe(403);
    expect(
      (await POST(request({ method: "POST", role: null, body: erasureBody }), context("cus_1")))
        .status,
    ).toBe(401);
    expect(core.eraseCustomerData).not.toHaveBeenCalled();
  });

  it("lets the owner through", async () => {
    const response = await POST(
      request({ method: "POST", body: erasureBody }),
      context("cus_1"),
    );
    expect(response.status).toBe(200);
    expect(core.eraseCustomerData).toHaveBeenCalledWith("cus_1", {
      requestedBy: "owner@hairsimo.it",
      reason: "subject_request ref:TCK-9",
    });
  });
});

describe("POST /api/customers/[id]/gdpr erasure confirmation", () => {
  it("will not fire without the literal confirmation", async () => {
    for (const body of [
      { ...erasureBody, confirm: undefined },
      { ...erasureBody, confirm: true },
      { ...erasureBody, confirm: "erase" },
      { ...erasureBody, confirm: "YES" },
    ]) {
      const response = await POST(request({ method: "POST", body }), context("cus_1"));
      expect(response.status).toBe(400);
    }
    expect(core.eraseCustomerData).not.toHaveBeenCalled();
  });

  it("will not fire when the confirmation names a different customer", async () => {
    const response = await POST(
      request({ method: "POST", body: { ...erasureBody, customerId: "cus_2" } }),
      context("cus_1"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("does not name the customer");
    expect(core.eraseCustomerData).not.toHaveBeenCalled();
  });

  it("rejects free-text reasons and references that could carry an identifier", async () => {
    for (const body of [
      { ...erasureBody, reason: `${SUBJECT.name} asked by mail` },
      { ...erasureBody, reference: SUBJECT.email },
      { ...erasureBody, reference: SUBJECT.phone },
    ]) {
      expect((await POST(request({ method: "POST", body }), context("cus_1"))).status).toBe(400);
    }
    expect(core.eraseCustomerData).not.toHaveBeenCalled();
  });

  it("404s an unknown customer and refuses a ticket belonging to somebody else", async () => {
    db.customerFindUnique.mockResolvedValue(null);
    expect(
      (
        await POST(
          request({ method: "POST", body: { ...erasureBody, customerId: "cus_x" } }),
          context("cus_x"),
        )
      ).status,
    ).toBe(404);

    db.customerFindUnique.mockResolvedValue({ id: "cus_1" });
    db.dataRequestFindUnique.mockResolvedValue({
      id: "dr_9",
      customerId: "cus_2",
      type: "erasure",
      status: "pending",
    });
    const mismatched = await POST(
      request({ method: "POST", body: { ...erasureBody, dataRequestId: "dr_9" } }),
      context("cus_1"),
    );
    expect(mismatched.status).toBe(409);

    db.dataRequestFindUnique.mockResolvedValue({
      id: "dr_9",
      customerId: "cus_1",
      type: "export",
      status: "pending",
    });
    const wrongType = await POST(
      request({ method: "POST", body: { ...erasureBody, dataRequestId: "dr_9" } }),
      context("cus_1"),
    );
    expect(wrongType.status).toBe(409);
    expect(core.eraseCustomerData).not.toHaveBeenCalled();
  });
});

describe("POST /api/customers/[id]/gdpr erasure record", () => {
  it("records who ordered it and what was swept, and no identifier at all", async () => {
    const response = await POST(request({ method: "POST", body: erasureBody }), context("cus_1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.receipt.identifiers.placeholderSuffix).toBe("a1b2c3d4");
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "gdpr.customer.erasure.ordered",
      entityType: "customer",
      entityId: "cus_1",
      actorId: "usr_1",
      actorEmail: "owner@hairsimo.it",
      actorRole: "owner",
    });
    expect(audits[0].after).toMatchObject({
      customerId: "cus_1",
      confirmed: "ERASE",
      reason: "subject_request",
      reference: "TCK-9",
      alreadyErased: false,
      dataRequestId: "dr_1",
      removed: { customerNotesDeleted: 2, messagesRedacted: 14 },
      retained: { payments: 3, appointments: 4 },
    });

    const written = JSON.stringify(audits[0]);
    for (const identifier of Object.values(SUBJECT)) {
      expect(written).not.toContain(identifier);
      expect(JSON.stringify(logs)).not.toContain(identifier);
    }
  });

  it("survives a re-run and reports it as already erased", async () => {
    core.eraseCustomerData.mockResolvedValue({
      receipt: { ...receipt, alreadyErased: true },
      dataRequestId: "dr_2",
      alreadyErased: true,
    });

    const response = await POST(request({ method: "POST", body: erasureBody }), context("cus_1"));
    expect(response.status).toBe(200);
    expect((await response.json()).data.receipt.alreadyErased).toBe(true);
    expect(audits[0].after).toMatchObject({ alreadyErased: true });
  });

  it("never returns a raw failure from the erasure transaction", async () => {
    core.eraseCustomerData.mockRejectedValue(
      new Error("Invalid `tx.customer.update()` invocation: deadlock detected"),
    );
    const response = await POST(request({ method: "POST", body: erasureBody }), context("cus_1"));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("deadlock");
  });
});

describe("erasure schema", () => {
  it("closes the vocabulary and rejects mass assignment", () => {
    expect(() => erasureSchema.parse({ ...erasureBody, force: true })).toThrow();
    expect(() => erasureSchema.parse({ ...erasureBody, reason: "because" })).toThrow();
    expect(erasureSchema.parse(erasureBody)).toEqual(erasureBody);
  });
});
