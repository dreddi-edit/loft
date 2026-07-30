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
} from "../../../../lib/admin-api";

const findAppointmentById = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  salonRepository: { findAppointmentById: (...args: unknown[]) => findAppointmentById(...args) },
}));

const { GET } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

function context(id = "apt_1") {
  return { params: Promise.resolve({ id }) };
}

function request(role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/appointments/apt_1", {
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
  findAppointmentById.mockReset();
  findAppointmentById.mockResolvedValue({ id: "apt_1", status: "confirmed" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("GET /api/appointments/[id]", () => {
  it("rejects a missing session with 401", async () => {
    const response = await GET(request(null), context());
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(findAppointmentById).not.toHaveBeenCalled();
  });

  it("rejects a role outside the allowlist with 403", async () => {
    const response = await GET(request("customer"), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(findAppointmentById).not.toHaveBeenCalled();
  });

  it("returns the appointment and writes no audit row for a read", async () => {
    const response = await GET(request("staff"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: "apt_1", status: "confirmed" } });
    expect(audits).toHaveLength(0);
  });

  it("returns 404 without echoing the requested id", async () => {
    findAppointmentById.mockResolvedValue(null);
    const response = await GET(request("staff"), context("apt_probe_12345"));
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: "APPOINTMENT_NOT_FOUND",
      message: safeMessageForCode("APPOINTMENT_NOT_FOUND"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("apt_probe_12345");
  });

  it("never leaks a repository failure to the browser", async () => {
    findAppointmentById.mockRejectedValue(
      new Error(
        "Invalid `prisma.appointment.findUnique()` invocation in /app/packages/db/src/client.ts:33",
      ),
    );
    const response = await GET(request("staff"), context());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("prisma");
    expect(JSON.stringify(body)).not.toContain("/app/packages");
  });
});
