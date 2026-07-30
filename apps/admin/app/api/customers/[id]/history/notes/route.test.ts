import { NextRequest } from "next/server";
import type { RoleKey } from "@hair-simo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAdminApiLogSink,
  resetAdminAuditWriter,
  resetAdminRateLimits,
  setAdminApiLogSink,
  setAdminAuditWriter,
  type AuditEntry,
} from "../../../../../../lib/admin-api";

const addNote = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "manager@hairsimo.it", role, firstName: "M", lastName: "G",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  CustomerHistoryService: vi.fn().mockImplementation(() => ({
    addNote: (...args: unknown[]) => addNote(...args),
  })),
  salonRepository: { createAuditLog: vi.fn() },
}));

const { POST } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const NOTE_VIEW = {
  id: "note_1",
  customerId: "cus_1",
  kind: "general" as const,
  text: "Prefers morning slots",
  raw: "Prefers morning slots",
  pinned: false,
  authorId: "usr_1",
  createdAt: "2026-07-29T10:00:00.000Z",
  createdAtLabel: "29 Jul 2026, 12:00",
  updatedAt: "2026-07-29T10:00:00.000Z",
};

let audits: AuditEntry[] = [];

function context(id = "cus_1") {
  return { params: Promise.resolve({ id }) };
}

function postRequest(body: unknown, role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/customers/cus_1/history/notes", {
    method: "POST",
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
  addNote.mockReset();
  addNote.mockResolvedValue(NOTE_VIEW);
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("POST /api/customers/[id]/history/notes", () => {
  it("rejects a missing session and a wrong role before calling the service", async () => {
    expect((await POST(postRequest({ note: "Hello" }, null), context())).status).toBe(401);
    expect((await POST(postRequest({ note: "Hello" }, "customer"), context())).status).toBe(403);
    expect(addNote).not.toHaveBeenCalled();
  });

  it("creates a note with the session actor", async () => {
    const response = await POST(
      postRequest({ note: "Prefers morning slots", kind: "general", pinned: false }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: NOTE_VIEW });
    expect(addNote).toHaveBeenCalledExactlyOnceWith({
      customerId: "cus_1",
      note: "Prefers morning slots",
      kind: "general",
      pinned: false,
      actor: { userId: "usr_1", email: "manager@hairsimo.it", role: "staff" },
    });
  });

  it("rejects unknown fields with 400", async () => {
    const response = await POST(postRequest({ note: "X", authorId: "usr_2" }), context());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(addNote).not.toHaveBeenCalled();
  });

  it("maps CUSTOMER_NOT_FOUND to 404", async () => {
    addNote.mockRejectedValue(new Error("CUSTOMER_NOT_FOUND"));
    const response = await POST(postRequest({ note: "Hello" }), context("cus_missing"));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("NOT_FOUND");
  });
});
