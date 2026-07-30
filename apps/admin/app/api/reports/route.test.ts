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

const getReportStats = vi.fn();

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
  salonRepository: { getReportStats: (...args: unknown[]) => getReportStats(...args) },
}));

const { GET, reportQuerySchema } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

function request(role: string | null = "owner", query = ""): NextRequest {
  return new NextRequest(`https://admin.hairsimo.it/api/reports${query}`, {
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
  getReportStats.mockReset();
  getReportStats.mockResolvedValue({ appointments: 42, revenueCents: 210_000, noShows: null });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("report query validation", () => {
  it("validates report ranges and export formats", () => {
    expect(
      reportQuerySchema.parse({ from: "2026-07-01", to: "2026-07-31", format: "csv" }),
    ).toMatchObject({
      format: "csv",
    });
    expect(() => reportQuerySchema.parse({ from: "2026-08-01", to: "2026-07-01" })).toThrow();
  });
});

describe("GET /api/reports", () => {
  it("rejects a missing session with 401", async () => {
    const response = await GET(request(null));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(getReportStats).not.toHaveBeenCalled();
  });

  it("is closed to the staff role even though it is a read", async () => {
    const response = await GET(request("staff"));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(getReportStats).not.toHaveBeenCalled();
  });

  it("returns JSON by default and writes no audit row", async () => {
    const response = await GET(request("owner"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { appointments: 42 } });
    expect(audits).toHaveLength(0);
  });

  it("exports CSV with quoted values and a download disposition", async () => {
    const response = await GET(request("manager", "?format=csv"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("hair-simo-report.csv");
    const csv = await response.text();
    expect(csv.split("\n")[0]).toBe("appointments,revenueCents,noShows");
    expect(csv.split("\n")[1]).toBe('"42","210000",""');
  });

  it("escapes a quote in a report value so the CSV cannot be broken out of", async () => {
    getReportStats.mockResolvedValue({ topService: 'Balayage "premium"' });
    const csv = await (await GET(request("owner", "?format=csv"))).text();
    expect(csv.split("\n")[1]).toBe('"Balayage ""premium"""');
  });

  it("rejects an inverted range, an unparseable date and an unknown format", async () => {
    const inverted = await GET(request("owner", "?from=2026-08-01&to=2026-07-01"));
    expect(inverted.status).toBe(400);
    expect((await inverted.json()).details[0].path).toBe("to");

    const unparseable = await GET(request("owner", "?from=whenever"));
    expect(unparseable.status).toBe(400);
    expect((await unparseable.json()).details[0].path).toBe("from");

    const format = await GET(request("owner", "?format=pdf"));
    expect(format.status).toBe(400);
    expect((await format.json()).details[0].path).toBe("format");
    expect(getReportStats).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter", async () => {
    const response = await GET(request("owner", "?groupBy=staffId"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(getReportStats).not.toHaveBeenCalled();
  });

  it("never leaks the aggregation failure to the browser", async () => {
    getReportStats.mockRejectedValue(
      new Error(
        'Raw query failed. Code: `42P01`. Message: `relation "Payment" does not exist` ' +
          "at /app/packages/core/src/repositories.ts:1204",
      ),
    );
    const response = await GET(request("owner"));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("42P01");
    expect(encoded).not.toContain("/app/packages");
  });
});
