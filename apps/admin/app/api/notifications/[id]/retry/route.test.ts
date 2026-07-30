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

const retry = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "owner@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  NotificationService: class {
    retry = retry;
  },
  salonRepository: {},
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

let audits: AuditEntry[] = [];

function context(id = "log_1") {
  return { params: Promise.resolve({ id }) };
}

function request(role: string | null = "manager"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/notifications/log_1/retry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
    body: "{}",
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
  retry.mockReset();
  retry.mockResolvedValue({
    record: { status: "sent", attempts: 2, channel: "sms" },
    delivered: true,
  });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("POST /api/notifications/[id]/retry", () => {
  it("rejects a missing session with 401", async () => {
    const response = await POST(request(null), context());
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("UNAUTHORIZED");
    expect(retry).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("is closed to the staff role", async () => {
    const response = await POST(request("staff"), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("FORBIDDEN");
    expect(retry).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("retries the notification named in the path and audits exactly once", async () => {
    const response = await POST(request("owner"), context("log_42"));
    expect(response.status).toBe(200);
    expect(retry).toHaveBeenCalledExactlyOnceWith("log_42");

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "notification.retry",
      entityType: "notificationLog",
      entityId: "log_42",
      actorId: "usr_1",
    });
    expect(audits[0].after).toMatchObject({ status: "sent", attempts: 2, channel: "sms" });
  });

  it("maps an unknown notification onto 404 and audits nothing", async () => {
    retry.mockRejectedValue(new Error("NOTIFICATION_NOT_FOUND"));
    const response = await POST(request("owner"), context("log_missing"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "NOT_FOUND",
      message: safeMessageForCode("NOT_FOUND"),
    });
    expect(audits).toHaveLength(0);
  });

  it("never leaks the delivery provider failure to the browser", async () => {
    retry.mockRejectedValue(
      new Error("Twilio 20003 authentication failed for account AC0123456789abcdef"),
    );
    const response = await POST(request("owner"), context());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "INTERNAL",
      message: safeMessageForCode("INTERNAL"),
      requestId: response.headers.get(REQUEST_ID_HEADER),
    });
    expect(JSON.stringify(body)).not.toContain("AC0123456789abcdef");
    expect(audits).toHaveLength(0);
  });
});
