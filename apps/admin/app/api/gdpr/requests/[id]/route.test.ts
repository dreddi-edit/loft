import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core, db } = vi.hoisted(() => ({
  core: {
    exportCustomerDataAsJson: vi.fn(),
    failDataRequest: vi.fn(),
    listDataRequests: vi.fn(),
    createDataRequest: vi.fn(),
  },
  db: {
    dataRequestFindUnique: vi.fn(),
    customerFindUnique: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  CUSTOMER_EXPORT_SCHEMA_VERSION: "hair-simo.gdpr.customer-export/1",
  gdprService: {
    exportCustomerDataAsJson: core.exportCustomerDataAsJson,
    failDataRequest: core.failDataRequest,
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
    dataRequest: { findUnique: db.dataRequestFindUnique },
    customer: { findUnique: db.customerFindUnique },
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
import { GET, PATCH, POST, dataRequestFailSchema } from "./route";

const URL = "https://admin.hairsimo.it/api/gdpr/requests/dr_1";
const SUBJECT_EMAIL = "anna.bauer@example.com";

let audits: AuditEntry[] = [];
let logs: LogRecord[] = [];

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "dr_1",
    customerId: "cus_1",
    type: "export",
    status: "pending",
    requestedBy: "owner@hairsimo.it",
    completedAt: null,
    resultLocation: null,
    error: null,
    createdAt: new Date("2026-07-29T08:00:00.000Z"),
    updatedAt: new Date("2026-07-29T08:00:00.000Z"),
    ...overrides,
  };
}

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

const exportFile = {
  filename: "hair-simo-data-export-cus_1-2026-07-29.json",
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({ subjectId: "cus_1", customer: { email: SUBJECT_EMAIL } }, null, 2),
  dataRequestId: "dr_1",
};

beforeEach(() => {
  audits = [];
  logs = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink((record) => logs.push(record));
  resetAdminRateLimits();
  core.exportCustomerDataAsJson.mockReset();
  core.failDataRequest.mockReset();
  db.dataRequestFindUnique.mockReset();
  db.dataRequestFindUnique.mockResolvedValue(row());
  core.exportCustomerDataAsJson.mockResolvedValue(exportFile);
});

afterEach(() => {
  resetAdminAuditWriter();
  resetAdminApiLogSink();
  resetAdminRateLimits();
});

describe("GET /api/gdpr/requests/[id]", () => {
  it("rejects an unauthenticated caller and a stylist", async () => {
    expect((await GET(request({ role: null }), context("dr_1"))).status).toBe(401);
    expect((await GET(request({ role: "staff" }), context("dr_1"))).status).toBe(403);
    expect(db.dataRequestFindUnique).not.toHaveBeenCalled();
  });

  it("parses the stored receipt back into the payload", async () => {
    db.dataRequestFindUnique.mockResolvedValue(
      row({ status: "completed", resultLocation: JSON.stringify({ alreadyErased: false }) }),
    );
    const response = await GET(request(), context("dr_1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.result).toEqual({ alreadyErased: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("404s an unknown id and 400s a malformed one", async () => {
    db.dataRequestFindUnique.mockResolvedValue(null);
    expect((await GET(request(), context("dr_missing"))).status).toBe(404);

    db.dataRequestFindUnique.mockClear();
    expect((await GET(request(), context("dr_1/../../"))).status).toBe(400);
    expect(db.dataRequestFindUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/gdpr/requests/[id] export delivery", () => {
  it("delivers the document as a download rather than a JSON body", async () => {
    const response = await POST(
      request({ method: "POST", body: { action: "process" } }),
      context("dr_1"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="hair-simo-data-export-cus_1-2026-07-29.json"',
    );
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(exportFile.body);
    expect(core.exportCustomerDataAsJson).toHaveBeenCalledWith("cus_1", {
      dataRequestId: "dr_1",
      requestedBy: "owner@hairsimo.it",
    });
  });

  it("records who disclosed how much without copying the document into the audit table", async () => {
    await POST(request({ method: "POST", body: { action: "process" } }), context("dr_1"));

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "gdpr.request.export",
      entityType: "dataRequest",
      entityId: "dr_1",
      actorEmail: "owner@hairsimo.it",
      actorRole: "owner",
    });
    expect(audits[0].after).toMatchObject({
      customerId: "cus_1",
      delivery: "attachment",
      bytes: Buffer.byteLength(exportFile.body, "utf8"),
    });
    expect(JSON.stringify(audits[0])).not.toContain(SUBJECT_EMAIL);
    expect(JSON.stringify(logs)).not.toContain(SUBJECT_EMAIL);
  });

  it("refuses to run an erasure from the queue endpoint", async () => {
    db.dataRequestFindUnique.mockResolvedValue(row({ type: "erasure" }));
    const response = await POST(
      request({ method: "POST", body: { action: "process" } }),
      context("dr_1"),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).message).toContain("customer erasure endpoint");
    expect(core.exportCustomerDataAsJson).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller and a stylist", async () => {
    expect(
      (await POST(request({ method: "POST", role: null, body: { action: "process" } }), context("dr_1")))
        .status,
    ).toBe(401);
    expect(
      (
        await POST(
          request({ method: "POST", role: "staff", body: { action: "process" } }),
          context("dr_1"),
        )
      ).status,
    ).toBe(403);
    expect(core.exportCustomerDataAsJson).not.toHaveBeenCalled();
  });

  it("only accepts the process action", async () => {
    const response = await POST(
      request({ method: "POST", body: { action: "erase" } }),
      context("dr_1"),
    );
    expect(response.status).toBe(400);
    expect(core.exportCustomerDataAsJson).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/gdpr/requests/[id] fail", () => {
  it("marks a pending request failed with a closed vocabulary", async () => {
    core.failDataRequest.mockResolvedValue(
      row({ status: "failed", error: "identity_not_verified ref:TCK-9" }),
    );

    const response = await PATCH(
      request({
        method: "PATCH",
        body: { action: "fail", reason: "identity_not_verified", reference: "TCK-9" },
      }),
      context("dr_1"),
    );

    expect(response.status).toBe(200);
    expect(core.failDataRequest).toHaveBeenCalledWith("dr_1", "identity_not_verified ref:TCK-9");
    expect(audits[0]).toMatchObject({ action: "gdpr.request.fail", entityId: "dr_1" });
    expect(audits[0].before).toMatchObject({ status: "pending" });
  });

  it("will not rewrite a completed request as failed", async () => {
    db.dataRequestFindUnique.mockResolvedValue(row({ status: "completed" }));
    const response = await PATCH(
      request({ method: "PATCH", body: { action: "fail", reason: "withdrawn" } }),
      context("dr_1"),
    );

    expect(response.status).toBe(409);
    expect(core.failDataRequest).not.toHaveBeenCalled();
  });

  it("refuses free text where an identifier could hide", () => {
    expect(() =>
      dataRequestFailSchema.parse({ action: "fail", reason: "anna.bauer@example.com asked" }),
    ).toThrow();
    expect(() =>
      dataRequestFailSchema.parse({
        action: "fail",
        reason: "withdrawn",
        reference: "anna.bauer@example.com",
      }),
    ).toThrow();
    expect(
      dataRequestFailSchema.parse({ action: "fail", reason: "withdrawn", reference: "TCK-3" }),
    ).toEqual({ action: "fail", reason: "withdrawn", reference: "TCK-3" });
  });
});
