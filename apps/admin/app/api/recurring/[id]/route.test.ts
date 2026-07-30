import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@hair-simo/core";
import type { RoleKey } from "@hair-simo/db";

const { core } = vi.hoisted(() => ({
  core: {
    getSeries: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    skipNext: vi.fn(),
    endSeries: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", () => ({
  RecurringService: class {
    getSeries = core.getSeries;
    pause = core.pause;
    resume = core.resume;
    skipNext = core.skipNext;
    endSeries = core.endSeries;
  },
  salonRepository: { createAuditLog: vi.fn() },
}));

vi.mock("../../../../lib/auth", () => ({
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
} from "../../../../lib/admin-api";
import { GET, PATCH } from "./route";

const URL = "https://admin.hairsimo.it/api/recurring/rs_1";

let audits: AuditEntry[] = [];

function request(init: { method?: string; role?: RoleKey | null; body?: unknown } = {}): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7" };
  const role = init.role === undefined ? "manager" : init.role;
  if (role !== null) headers["x-test-role"] = role;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(URL, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeEach(() => {
  audits = [];
  setAdminAuditWriter(async (entry) => {
    audits.push(entry);
  });
  setAdminApiLogSink(() => {});
  resetAdminRateLimits();
  core.getSeries.mockReset().mockResolvedValue({ id: "rs_1", active: true });
  core.pause.mockReset().mockResolvedValue({ seriesId: "rs_1", active: false, nextAt: new Date(), endsAt: null });
  core.resume.mockReset().mockResolvedValue({ seriesId: "rs_1", active: true, nextAt: new Date(), endsAt: null });
  core.skipNext.mockReset().mockResolvedValue({ seriesId: "rs_1", active: true, nextAt: new Date(), endsAt: null });
  core.endSeries.mockReset().mockResolvedValue({
    seriesId: "rs_1",
    active: false,
    nextAt: new Date(),
    endsAt: new Date(),
    cancelledAppointmentIds: [],
  });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
});

describe("GET /api/recurring/[id]", () => {
  it("returns the series", async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: "rs_1" }) });
    expect(response.status).toBe(200);
    expect(core.getSeries).toHaveBeenCalledWith("rs_1");
  });

  it("maps SERIES_NOT_FOUND to 404", async () => {
    core.getSeries.mockRejectedValue(new Error("SERIES_NOT_FOUND"));
    const response = await GET(request(), { params: Promise.resolve({ id: "rs_missing" }) });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/recurring/[id]", () => {
  it("pauses a series and audits", async () => {
    const response = await PATCH(request({ method: "PATCH", body: { action: "pause" } }), {
      params: Promise.resolve({ id: "rs_1" }),
    });
    expect(response.status).toBe(200);
    expect(core.pause).toHaveBeenCalledWith("rs_1");
    expect(audits[0]?.action).toBe("recurring.pause");
  });

  it("resumes a series", async () => {
    const response = await PATCH(request({ method: "PATCH", body: { action: "resume" } }), {
      params: Promise.resolve({ id: "rs_1" }),
    });
    expect(response.status).toBe(200);
    expect(core.resume).toHaveBeenCalledWith("rs_1");
  });

  it("skips the next occurrence", async () => {
    const response = await PATCH(
      request({ method: "PATCH", body: { action: "skip", reason: "holiday" } }),
      { params: Promise.resolve({ id: "rs_1" }) },
    );
    expect(response.status).toBe(200);
    expect(core.skipNext).toHaveBeenCalledWith("rs_1", "holiday");
  });

  it("ends a series and can cancel future appointments", async () => {
    const response = await PATCH(
      request({
        method: "PATCH",
        body: { action: "end", cancelFutureAppointments: true, reason: "moved away" },
      }),
      { params: Promise.resolve({ id: "rs_1" }) },
    );
    expect(response.status).toBe(200);
    expect(core.endSeries).toHaveBeenCalledWith("rs_1", {
      cancelFutureAppointments: true,
      reason: "moved away",
    });
  });

  it("rejects staff for mutations", async () => {
    const response = await PATCH(request({ method: "PATCH", role: "staff", body: { action: "pause" } }), {
      params: Promise.resolve({ id: "rs_1" }),
    });
    expect(response.status).toBe(403);
    expect(core.pause).not.toHaveBeenCalled();
  });
});
