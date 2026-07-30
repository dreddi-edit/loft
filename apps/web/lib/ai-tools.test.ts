import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBookingToolState } from "@hair-simo/ai";

const core = vi.hoisted(() => ({
  getAvailability: vi.fn(),
  createBooking: vi.fn(),
  reschedule: vi.fn(),
  cancel: vi.fn(),
  getPricing: vi.fn(),
  verifyAppointmentAccessToken: vi.fn(),
  repo: {
    listServices: vi.fn(),
    findServiceBySlug: vi.fn(),
    listBusinessHours: vi.fn(),
    findAppointmentById: vi.fn(),
    recordConsent: vi.fn(),
    addCustomerNote: vi.fn(),
  },
}));

vi.mock("@hair-simo/core", async () => {
  const time = await vi.importActual<typeof import("@hair-simo/core/time")>("@hair-simo/core/time");
  return {
    resolveTenantContext: async () => ({
      tenantId: "cltenant00000000000000001",
      slug: "hairsimo-brixen",
      displayName: "Hair Simo",
      timeZone: "Europe/Rome",
      defaultLocale: "it",
    }),
    BookingService: class {
      getAvailability = core.getAvailability;
      createBooking = core.createBooking;
      reschedule = core.reschedule;
      cancel = core.cancel;
    },
    PricingService: class {
      getPricing = core.getPricing;
    },
    salonRepository: core.repo,
    verifyAppointmentAccessToken: core.verifyAppointmentAccessToken,
    formatSalonTimeRange: time.formatSalonTimeRange,
    salonDayKey: time.salonDayKey,
  };
});

const { createAiTools } = await import("./ai-tools");

/** 10:00 salon wall clock on a summer day is 08:00Z: Europe/Rome is CEST in August. */
const SLOT_TEN = new Date("2026-08-05T08:00:00.000Z");
const SLOT_ELEVEN = new Date("2026-08-05T09:00:00.000Z");

const SERVICE_ROW = {
  id: "svc-1",
  slug: "damen-schnitt",
  isActive: true,
  durationMin: 60,
  priceCents: 6_000,
  translations: [
    { locale: "de", name: "Damenschnitt" },
    { locale: "it", name: "Taglio donna" },
  ],
};

const PRICING = {
  serviceSlug: "damen-schnitt",
  total: { amountCents: 6_000, currency: "EUR" as const },
  deposit: { amountCents: 1_800, currency: "EUR" as const },
  fullPayment: { amountCents: 6_000, currency: "EUR" as const },
  depositRequired: true,
  depositPercentage: 30,
  depositThresholdCents: 5_000,
};

function appointmentRow(id: string, customerId: string, status = "confirmed") {
  return {
    id,
    customerId,
    startsAt: SLOT_TEN,
    endsAt: SLOT_ELEVEN,
    status,
    service: SERVICE_ROW,
    staff: { displayName: "Simona" },
  };
}

let conversationCounter = 0;

function tools(options: { locale?: "de" | "it"; accessToken?: string } = {}) {
  conversationCounter += 1;
  return createAiTools({
    locale: options.locale ?? "de",
    channel: "web",
    conversationId: `web:test-${conversationCounter}`,
    accessToken: options.accessToken,
  });
}

beforeEach(() => {
  resetBookingToolState();
  vi.clearAllMocks();
  core.repo.listBusinessHours.mockResolvedValue([
    { dayOfWeek: 0, isOpen: false, startMin: 0, endMin: 0 },
    { dayOfWeek: 1, isOpen: false, startMin: 0, endMin: 0 },
    { dayOfWeek: 2, isOpen: true, startMin: 480, endMin: 1_020 },
    { dayOfWeek: 3, isOpen: true, startMin: 480, endMin: 960 },
  ]);
  core.repo.listServices.mockResolvedValue([SERVICE_ROW]);
  core.repo.findServiceBySlug.mockImplementation(async (slug: string) =>
    slug === SERVICE_ROW.slug ? SERVICE_ROW : null,
  );
  core.repo.findAppointmentById.mockImplementation(async (id: string) =>
    id === "appt-a" ? appointmentRow("appt-a", "cust-a") : null,
  );
  core.repo.recordConsent.mockResolvedValue(undefined);
  core.repo.addCustomerNote.mockResolvedValue(undefined);
  core.getPricing.mockResolvedValue(PRICING);
  core.cancel.mockResolvedValue(appointmentRow("appt-a", "cust-a", "cancelled"));
  core.reschedule.mockResolvedValue(appointmentRow("appt-a", "cust-a"));
  core.getAvailability.mockResolvedValue([
    { startsAt: SLOT_TEN, endsAt: SLOT_ELEVEN },
    { startsAt: SLOT_ELEVEN, endsAt: new Date("2026-08-05T10:00:00.000Z") },
  ]);
  core.verifyAppointmentAccessToken.mockImplementation(async (token: string) => {
    if (token === "token-a") return { appointmentId: "appt-a", customerId: "cust-a" };
    if (token === "token-b") return { appointmentId: "appt-b", customerId: "cust-b" };
    throw new Error("APPOINTMENT_TOKEN_INVALID");
  });
});

describe("createAiTools", () => {
  it("still accepts a bare locale, as the shared channel route passes it", async () => {
    const result = await createAiTools("it").getServiceInfo({ service: "damen-schnitt" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Taglio donna");
    expect(result.message).toContain("totale");
  });

  it("answers in the session locale", async () => {
    const result = await tools({ locale: "de" }).getServiceInfo({ service: "damen-schnitt" });
    expect(result.message).toContain("Damenschnitt");
    expect(result.message).toContain("Gesamt 60.00 EUR");
    expect(result.message).toContain("Anzahlung 18.00 EUR");
  });
});

describe("opening hours", () => {
  it("come from the BusinessHours table and not from a string in the code", async () => {
    const result = await tools().getOpeningHours({});

    expect(core.repo.listBusinessHours).toHaveBeenCalledTimes(1);
    expect(result.data?.source).toBe("business-hours");
    expect(result.message).toContain("Dienstag 08:00-17:00");
    expect(result.message).toContain("Mittwoch 08:00-16:00");
    expect(result.message).toContain("Via Bastioni Maggiori, 4/c, 39042 Bressanone (BZ)");
  });

  it("marks the static times when the table has not been filled in", async () => {
    core.repo.listBusinessHours.mockResolvedValue([]);
    const result = await tools().getOpeningHours({});
    expect(result.data?.source).toBe("static-fallback");
    expect(result.message).toContain("Standardzeiten");
  });
});

describe("service resolution", () => {
  it("refuses an unknown service instead of silently defaulting to damen-schnitt", async () => {
    const result = await tools().checkAvailability({ service: "goldene-perueckenkur" });
    expect(result.error).toBe("SERVICE_NOT_FOUND");
    expect(core.getAvailability).not.toHaveBeenCalled();
  });

  it("still resolves the aliases a customer actually says", async () => {
    const result = await tools().checkAvailability({
      service: "Damenhaarschnitt",
      day: "2026-08-05",
    });
    expect(result.ok).toBe(true);
    expect(core.getAvailability).toHaveBeenCalledWith("damen-schnitt", "2026-08-05");
    expect(result.message).toContain("10:00");
  });
});

describe("appointment tools", () => {
  it("refuse to cancel without a manage-link token", async () => {
    const result = await tools().cancelBooking({ appointmentId: "appt-a" });
    expect(result.error).toBe("ACCESS_TOKEN_REQUIRED");
    expect(core.cancel).not.toHaveBeenCalled();
  });

  it("cancel the appointment the token names, not the one the model names", async () => {
    const result = await tools({ accessToken: "token-a" }).cancelBooking({
      appointmentId: "appt-b",
      reason: "andere Plaene",
    });

    expect(result.ok).toBe(true);
    expect(core.verifyAppointmentAccessToken).toHaveBeenCalledWith("token-a");
    expect(core.repo.findAppointmentById).toHaveBeenCalledWith("appt-a");
    expect(core.cancel).toHaveBeenCalledTimes(1);
    expect(core.cancel.mock.calls[0][0]).toBe("appt-a");
  });

  it("refuse a token whose appointment no longer exists", async () => {
    const result = await tools({ accessToken: "token-b" }).cancelBooking({});
    expect(result.error).toBe("APPOINTMENT_NOT_FOUND");
    expect(core.cancel).not.toHaveBeenCalled();
  });
});

describe("booking a new appointment", () => {
  it("goes through the read-back and books the salon wall clock the customer said", async () => {
    core.createBooking.mockResolvedValue(appointmentRow("appt-new", "cust-new", "pending"));
    const session = tools();

    const ready = await session.collectBookingDetails({
      service: "damen-schnitt",
      day: "2026-08-05",
      time: "10:00",
      firstName: "Anna",
      lastName: "Gruber",
      email: "anna@example.com",
    });
    expect(ready.data?.status).toBe("ready");
    expect(core.createBooking).not.toHaveBeenCalled();

    const confirmed = await session.confirmBooking({
      confirmationCode: ready.data?.confirmationCode as string,
      consent: true,
    });

    expect(confirmed.ok).toBe(true);
    expect(core.createBooking).toHaveBeenCalledTimes(1);
    expect(core.createBooking.mock.calls[0][0]).toMatchObject({
      serviceSlug: "damen-schnitt",
      startsAt: SLOT_TEN.toISOString(),
      customerEmail: "anna@example.com",
      customerFirstName: "Anna",
      customerLastName: "Gruber",
      sourceChannel: "web",
      termsAccepted: true,
    });
    expect(core.repo.recordConsent).toHaveBeenCalledWith(
      "cust-new",
      "assistant_readback",
      true,
      "chat:web",
    );
  });

  it("does not book on a confirmation code the model made up", async () => {
    const session = tools();
    await session.collectBookingDetails({
      service: "damen-schnitt",
      day: "2026-08-05",
      time: "10:00",
      firstName: "Anna",
      lastName: "Gruber",
      email: "anna@example.com",
    });

    const confirmed = await session.confirmBooking({
      confirmationCode: "HACKED42",
      consent: true,
    });

    expect(confirmed.error).toBe("CONFIRMATION_REQUIRED");
    expect(core.createBooking).not.toHaveBeenCalled();
  });
});
