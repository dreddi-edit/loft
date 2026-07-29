import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OFFER_TTL_MS = 20 * 60_000;

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  readWaitlistOfferToken: vi.fn(),
  createAppointmentAccessToken: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@hair-simo/core", () => {
  class WaitlistError extends Error {
    readonly code: string;

    constructor(code: string, detail?: string) {
      super(detail ? `${code}: ${detail}` : code);
      this.name = "WaitlistError";
      this.code = code;
    }
  }

  return {
    resolveTenantContext: async () => ({
      tenantId: "cltenant00000000000000001",
      slug: "hairsimo-brixen",
      displayName: "Hair Simo",
      timeZone: "Europe/Rome",
      defaultLocale: "it",
    }),
    WaitlistError,
    WaitlistService: class {
      claim = mocks.claim;
    },
    readWaitlistOfferToken: mocks.readWaitlistOfferToken,
    createAppointmentAccessToken: mocks.createAppointmentAccessToken,
    offerExpiresAt: (notifiedAt: Date, slotStartsAt: Date) =>
      new Date(Math.min(notifiedAt.getTime() + OFFER_TTL_MS, slotStartsAt.getTime())),
  };
});

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

  runWithTenantAsync: async (_ctx: unknown, fn: () => unknown) => fn(), prisma: { waitlist: { findUnique: mocks.findUnique } } }));

import { WaitlistError } from "@hair-simo/core";
import { resetApiLogSink, setApiLogSink } from "../../../../lib/api-handler";
import { resetRateLimitStore } from "../../../../lib/rate-limit";
import { GET, POST } from "./route";

const CLOUD_RUN_CHAIN = "203.0.113.7, 35.191.10.1";
const TOKEN = "d1JhbGlk.c2lnbmF0dXJl";

type Claims = {
  entryId: string;
  staffId: string;
  slotStartsAt: Date;
  notifiedAtMs: number;
};

function claimsFor(overrides: Partial<Claims> = {}): Claims {
  return {
    entryId: "wl_1",
    staffId: "stf_1",
    slotStartsAt: new Date(Date.now() + 3 * 60 * 60_000),
    notifiedAtMs: Date.now() - 60_000,
    ...overrides,
  };
}

function entryFor(claims: Claims, overrides: Record<string, unknown> = {}) {
  return {
    status: "notified",
    notifiedAt: new Date(claims.notifiedAtMs),
    service: {
      slug: "cut",
      durationMin: 60,
      translations: [{ locale: "it", name: "Taglio" }],
    },
    ...overrides,
  };
}

function context(token = TOKEN) {
  return { params: Promise.resolve({ token }) };
}

function getRequest(token = TOKEN): NextRequest {
  return new NextRequest(`https://hairsimo.it/api/waitlist/${token}`, {
    headers: { "x-forwarded-for": CLOUD_RUN_CHAIN },
  });
}

function postRequest(body?: unknown): NextRequest {
  return new NextRequest(`https://hairsimo.it/api/waitlist/${TOKEN}`, {
    method: "POST",
    headers: {
      "x-forwarded-for": CLOUD_RUN_CHAIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const APPOINTMENT = {
  id: "apt_new",
  customerId: "cus_1",
  serviceId: "svc_cut",
  status: "pending",
  locale: "it",
  startsAt: new Date("2026-08-03T09:00:00.000Z"),
  endsAt: new Date("2026-08-03T10:00:00.000Z"),
};

beforeEach(() => {
  setApiLogSink(() => {});
  resetRateLimitStore();
  mocks.claim.mockReset();
  mocks.readWaitlistOfferToken.mockReset();
  mocks.createAppointmentAccessToken.mockReset();
  mocks.findUnique.mockReset();
  mocks.createAppointmentAccessToken.mockResolvedValue("manage.jwt.value");
});

afterEach(() => {
  resetApiLogSink();
  resetRateLimitStore();
});

describe("GET /api/waitlist/[token]", () => {
  it("previews a live offer without disclosing the customer", async () => {
    const claims = claimsFor();
    mocks.readWaitlistOfferToken.mockReturnValue(claims);
    mocks.findUnique.mockResolvedValue(entryFor(claims));

    const response = await GET(getRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.state).toBe("open");
    expect(body.data.slot.startsAt).toBe(claims.slotStartsAt.toISOString());
    expect(body.data.slot.endsAt).toBe(
      new Date(claims.slotStartsAt.getTime() + 60 * 60_000).toISOString(),
    );
    expect(body.data.offerExpiresAt).toBe(
      new Date(claims.notifiedAtMs + OFFER_TTL_MS).toISOString(),
    );
    expect(body.data.service).toEqual({
      slug: "cut",
      translations: [{ locale: "it", name: "Taglio" }],
    });
    expect(JSON.stringify(body)).not.toContain("cus_");
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "wl_1" } }),
    );
  });

  it("never reaches the database for a token that does not verify", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(null);

    const response = await GET(getRequest("forged"), context("forged"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: "This waitlist link is invalid or has expired.",
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("reports a lapsed, superseded, claimed or missing offer", async () => {
    const lapsed = claimsFor({ notifiedAtMs: Date.now() - 60 * 60_000 });
    mocks.readWaitlistOfferToken.mockReturnValue(lapsed);
    mocks.findUnique.mockResolvedValue(entryFor(lapsed));
    expect((await (await GET(getRequest(), context())).json()).data.state).toBe("expired");

    const current = claimsFor();
    mocks.readWaitlistOfferToken.mockReturnValue(current);
    mocks.findUnique.mockResolvedValue(
      entryFor(current, { notifiedAt: new Date(current.notifiedAtMs + 1_000) }),
    );
    expect((await (await GET(getRequest(), context())).json()).data.state).toBe("unavailable");

    mocks.findUnique.mockResolvedValue(entryFor(current, { status: "converted" }));
    expect((await (await GET(getRequest(), context())).json()).data.state).toBe("claimed");

    mocks.findUnique.mockResolvedValue(null);
    const gone = await GET(getRequest(), context());
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe("NOT_FOUND");
  });

  it("refuses methods other than GET", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    const response = await GET(postRequest(), context());
    expect(response.status).toBe(405);
  });
});

describe("POST /api/waitlist/[token]", () => {
  it("claims the slot for the entry named by the token and returns a manage link", async () => {
    const claims = claimsFor();
    mocks.readWaitlistOfferToken.mockReturnValue(claims);
    mocks.claim.mockResolvedValue({
      won: true,
      entry: { id: "wl_1", locale: "it" },
      appointment: APPOINTMENT,
      alreadyClaimed: false,
    });

    const response = await POST(postRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      claimed: true,
      alreadyClaimed: false,
      appointment: {
        id: "apt_new",
        status: "pending",
        startsAt: APPOINTMENT.startsAt.toISOString(),
        endsAt: APPOINTMENT.endsAt.toISOString(),
      },
      manageUrl: "http://localhost:3000/it/manage/manage.jwt.value",
    });
    expect(mocks.claim).toHaveBeenCalledWith("wl_1", { token: TOKEN });
    expect(JSON.stringify(body)).not.toContain("cus_1");
  });

  it("refuses a body that tries to name a different entry", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());

    const response = await POST(postRequest({ entryId: "wl_victim" }), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VALIDATION_ERROR");
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable token before claiming anything", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(null);

    const response = await POST(postRequest(), context("forged"));

    expect(response.status).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("tells the loser of a race that the slot is gone without naming the winner", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    mocks.claim.mockResolvedValue({
      won: false,
      reason: "SLOT_TAKEN",
      conflictingAppointmentId: "apt_of_someone_else",
    });

    const response = await POST(postRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ data: { claimed: false, reason: "SLOT_TAKEN" } });
    expect(JSON.stringify(body)).not.toContain("apt_of_someone_else");
  });

  it("is idempotent for a double click", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    mocks.claim.mockResolvedValue({
      won: true,
      entry: { id: "wl_1", locale: "it" },
      appointment: APPOINTMENT,
      alreadyClaimed: true,
    });

    const first = await POST(postRequest(), context());
    const second = await POST(postRequest(), context());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.data.claimed).toBe(true);
    expect(body.data.alreadyClaimed).toBe(true);
    expect(body.data.appointment.id).toBe("apt_new");
  });

  it("re-reads once when a concurrent tap lost the write conflict", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    mocks.claim
      .mockResolvedValueOnce({ won: false, reason: "OFFER_NOT_ACTIVE" })
      .mockResolvedValueOnce({
        won: true,
        entry: { id: "wl_1", locale: "it" },
        appointment: APPOINTMENT,
        alreadyClaimed: true,
      });

    const response = await POST(postRequest(), context());
    const body = await response.json();

    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(body.data).toMatchObject({ claimed: true, alreadyClaimed: true });
  });

  it("reports a genuinely dead offer once instead of looping", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    mocks.claim.mockResolvedValue({ won: false, reason: "OFFER_NOT_ACTIVE" });

    const response = await POST(postRequest(), context());

    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      data: { claimed: false, reason: "OFFER_NOT_ACTIVE" },
    });
  });

  it("maps a rejected offer token thrown by the service onto 401", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    mocks.claim.mockRejectedValue(new WaitlistError("OFFER_TOKEN_INVALID"));

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: "This waitlist link is invalid or has expired.",
    });
  });

  it("never leaks a configuration failure", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    mocks.claim.mockRejectedValue(new WaitlistError("OFFER_SECRET_MISSING"));

    const response = await POST(postRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("OFFER_SECRET_MISSING");
  });

  it("still confirms the appointment when the manage link cannot be minted", async () => {
    mocks.readWaitlistOfferToken.mockReturnValue(claimsFor());
    mocks.claim.mockResolvedValue({
      won: true,
      entry: { id: "wl_1", locale: "it" },
      appointment: APPOINTMENT,
      alreadyClaimed: false,
    });
    mocks.createAppointmentAccessToken.mockRejectedValue(new Error("JWT_SECRET_MISSING"));

    const response = await POST(postRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.claimed).toBe(true);
    expect(body.data.manageUrl).toBeNull();
    expect(JSON.stringify(body)).not.toContain("JWT_SECRET_MISSING");
  });
});
