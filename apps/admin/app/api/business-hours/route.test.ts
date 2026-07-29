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
} from "../../../lib/admin-api";

const listBusinessHours = vi.fn();
const upsertBusinessHours = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  salonRepository: {
    listBusinessHours: (...args: unknown[]) => listBusinessHours(...args),
    upsertBusinessHours: (...args: unknown[]) => upsertBusinessHours(...args),
  },
}));

const { GET, PUT } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

const MONDAY = { id: "bh_1", dayOfWeek: 1, startMin: 540, endMin: 1_080, isOpen: true };
const VALID_PUT = { dayOfWeek: 1, startMin: 540, endMin: 1_020, isOpen: true };

function getRequest(role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/business-hours", {
    method: "GET",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
  });
}

function putRequest(body: unknown, role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/business-hours", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
    body: JSON.stringify(body),
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
  listBusinessHours.mockReset();
  upsertBusinessHours.mockReset();
  listBusinessHours.mockResolvedValue([MONDAY]);
  upsertBusinessHours.mockResolvedValue({ ...MONDAY, endMin: 1_020 });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/business-hours", () => {
  it("rejects a missing session with 401 and a wrong role with 403", async () => {
    expect((await GET(getRequest(null))).status).toBe(401);
    expect((await GET(getRequest("customer"))).status).toBe(403);
    expect(listBusinessHours).not.toHaveBeenCalled();
  });

  it("returns the schedule and writes no audit row", async () => {
    const response = await GET(getRequest("staff"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [MONDAY] });
    expect(audits).toHaveLength(0);
  });
});

describe("PUT /api/business-hours", () => {
  it("is closed to the staff role even though reading is not", async () => {
    expect((await PUT(putRequest(VALID_PUT, null))).status).toBe(401);
    const staff = await PUT(putRequest(VALID_PUT, "staff"));
    expect(staff.status).toBe(403);
    expect((await staff.json()).error).toBe("FORBIDDEN");
    expect(upsertBusinessHours).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("writes exactly one audit row with the previous and the new window", async () => {
    const response = await PUT(putRequest(VALID_PUT));
    expect(response.status).toBe(200);
    expect(upsertBusinessHours).toHaveBeenCalledExactlyOnceWith(1, 540, 1_020, true);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "businessHours.upsert",
      entityType: "businessHours",
      entityId: "bh_1",
      actorRole: "manager",
    });
    expect(audits[0].before).toMatchObject({ endMin: 1_080 });
    expect(audits[0].after).toMatchObject({ endMin: 1_020 });
  });

  it("refuses a day outside the week and a minute outside the day", async () => {
    const day = await PUT(putRequest({ ...VALID_PUT, dayOfWeek: 7 }));
    expect(day.status).toBe(400);
    expect((await day.json()).details[0].path).toBe("dayOfWeek");

    const minute = await PUT(putRequest({ ...VALID_PUT, endMin: 2_000 }));
    expect(minute.status).toBe(400);
    expect((await minute.json()).details[0].path).toBe("endMin");
    expect(upsertBusinessHours).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("refuses an open day that closes before it opens", async () => {
    const response = await PUT(putRequest({ ...VALID_PUT, startMin: 900, endMin: 600 }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details[0].path).toBe("endMin");
    expect(body.details[0].message).toBe("endMin must be after startMin on an open day");
    expect(audits).toHaveLength(0);
  });

  it("rejects an unknown field instead of silently ignoring it", async () => {
    const response = await PUT(putRequest({ ...VALID_PUT, salonId: "other-salon" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(upsertBusinessHours).not.toHaveBeenCalled();
  });

  it("never leaks a repository failure to the browser", async () => {
    upsertBusinessHours.mockRejectedValue(
      new Error(
        "Invalid `prisma.businessHours.upsert()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );
    const response = await PUT(putRequest(VALID_PUT));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(audits).toHaveLength(0);
  });
});
