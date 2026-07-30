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
} from "../../../../../../../lib/admin-api";

const updateNote = vi.fn();
const deleteNote = vi.fn();
const customerNoteFindUnique = vi.fn();

const requireSession = vi.fn(async (request: NextRequest, allowed: RoleKey[]) => {
  const role = request.headers.get("x-test-role") as RoleKey | null;
  if (!role) throw new Error("UNAUTHENTICATED");
  if (!allowed.includes(role)) throw new Error("FORBIDDEN");
  return { userId: "usr_1", email: "staff@hairsimo.it", role, firstName: "S", lastName: "R",
    tenantId: "cltenant00000000000000001",
    tenantSlug: "hairsimo-brixen",
  };
});

vi.mock("../../../../../../../lib/auth", () => ({
  requireSession: (...args: Parameters<typeof requireSession>) => requireSession(...args),
}));

vi.mock("@hair-simo/core", () => ({
  CustomerHistoryService: vi.fn().mockImplementation(() => ({
    updateNote: (...args: unknown[]) => updateNote(...args),
    deleteNote: (...args: unknown[]) => deleteNote(...args),
  })),
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
    customerNote: { findUnique: (...args: unknown[]) => customerNoteFindUnique(...args) },
  },
}));

const { PATCH, DELETE } = await import("./route");

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";

const NOTE_VIEW = {
  id: "note_1",
  customerId: "cus_1",
  kind: "general" as const,
  text: "Updated text",
  raw: "Updated text",
  pinned: true,
  authorId: "usr_1",
  createdAt: "2026-07-29T10:00:00.000Z",
  createdAtLabel: "29 Jul 2026, 12:00",
  updatedAt: "2026-07-29T11:00:00.000Z",
};

let audits: AuditEntry[] = [];

function context(id = "cus_1", noteId = "note_1") {
  return { params: Promise.resolve({ id, noteId }) };
}

function patchRequest(body: unknown, role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/customers/cus_1/history/notes/note_1", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(role ? { "x-test-role": role } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deleteRequest(body: unknown = {}, role: string | null = "staff"): NextRequest {
  return new NextRequest("https://admin.hairsimo.it/api/customers/cus_1/history/notes/note_1", {
    method: "DELETE",
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
  updateNote.mockReset();
  deleteNote.mockReset();
  customerNoteFindUnique.mockReset();
  updateNote.mockResolvedValue(NOTE_VIEW);
  deleteNote.mockResolvedValue({ id: "note_1", kind: "general" });
  customerNoteFindUnique.mockResolvedValue({ customerId: "cus_1" });
});

afterEach(() => {
  resetAdminApiLogSink();
  resetAdminAuditWriter();
  resetAdminRateLimits();
  vi.restoreAllMocks();
});

describe("PATCH /api/customers/[id]/history/notes/[noteId]", () => {
  it("rejects a missing session and a wrong role", async () => {
    expect((await PATCH(patchRequest({ note: "X" }, null), context())).status).toBe(401);
    expect((await PATCH(patchRequest({ note: "X" }, "customer"), context())).status).toBe(403);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("updates a note belonging to the customer", async () => {
    const response = await PATCH(patchRequest({ note: "Updated text", pinned: true }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: NOTE_VIEW });
    expect(updateNote).toHaveBeenCalledExactlyOnceWith(
      "note_1",
      { note: "Updated text", pinned: true },
      { actor: { userId: "usr_1", email: "staff@hairsimo.it", role: "staff" } },
    );
  });

  it("returns 404 when the note belongs to another customer", async () => {
    customerNoteFindUnique.mockResolvedValue({ customerId: "cus_other" });
    const response = await PATCH(patchRequest({ note: "X" }), context());
    expect(response.status).toBe(404);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("maps ALLERGY_NOTE_MUST_STAY_PINNED to 409", async () => {
    updateNote.mockRejectedValue(new Error("ALLERGY_NOTE_MUST_STAY_PINNED"));
    const response = await PATCH(patchRequest({ pinned: false }), context());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("CONFLICT");
  });
});

describe("DELETE /api/customers/[id]/history/notes/[noteId]", () => {
  it("deletes a general note without confirmation", async () => {
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: "note_1", kind: "general" } });
    expect(deleteNote).toHaveBeenCalledExactlyOnceWith("note_1", {
      actor: { userId: "usr_1", email: "staff@hairsimo.it", role: "staff" },
    });
  });

  it("passes confirmAllergyDeletion when provided", async () => {
    deleteNote.mockResolvedValue({ id: "note_1", kind: "allergy" });
    const response = await DELETE(deleteRequest({ confirmAllergyDeletion: true }), context());
    expect(response.status).toBe(200);
    expect(deleteNote).toHaveBeenCalledExactlyOnceWith("note_1", {
      actor: { userId: "usr_1", email: "staff@hairsimo.it", role: "staff" },
      confirmAllergyDeletion: true,
    });
  });

  it("maps ALLERGY_NOTE_DELETE_NOT_CONFIRMED to 409", async () => {
    deleteNote.mockRejectedValue(new Error("ALLERGY_NOTE_DELETE_NOT_CONFIRMED"));
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("CONFLICT");
  });

  it("returns 404 when the note does not exist", async () => {
    customerNoteFindUnique.mockResolvedValue(null);
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(404);
    expect(deleteNote).not.toHaveBeenCalled();
  });
});
