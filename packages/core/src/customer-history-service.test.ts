import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerNoteKind } from "@hair-simo/db";

type NoteShape = {
  id: string;
  customerId: string;
  note: string;
  kind: CustomerNoteKind;
  authorId: string | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type CustomerRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  marketingOptIn: boolean;
  createdAt: Date;
  deletedAt: Date | null;
  anonymizedAt: Date | null;
};

const { db, customers } = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    customers: store,
    db: {
      customer: {
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) => {
            const row = store.get(String(where.id));
            if (!row) return null;
            if (where.deletedAt === null && row.deletedAt !== null) return null;
            if (where.anonymizedAt === null && row.anonymizedAt !== null) return null;
            return row;
          },
        ),
      },
      customerNote: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      appointment: { findMany: vi.fn() },
      auditLog: { create: vi.fn(async () => ({ id: "audit-1" })) },
    },
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
 prisma: db }));

import {
  CustomerHistoryService,
  parseFormulaNote,
  serializeFormula,
} from "./customer-history-service";

const NOW = new Date("2026-07-29T09:00:00.000Z");

const customer: CustomerRow = {
  id: "cus-1",
  firstName: "Anna",
  lastName: "Rossi",
  email: "anna@example.it",
  phone: "+390472268402",
  locale: "it",
  marketingOptIn: true,
  createdAt: new Date("2023-01-10T10:00:00.000Z"),
  deletedAt: null,
  anonymizedAt: null,
};

function service(slug: string, priceCents: number) {
  return {
    slug,
    priceCents,
    translations: [
      { locale: "it", name: slug === "balayage-straehnen" ? "Balayage & Meches" : "Taglio donna" },
      { locale: "de", name: slug === "balayage-straehnen" ? "Balayage" : "Damenschnitt" },
    ],
  };
}

const sara = { id: "staff-sara", displayName: "Sara" };
const marco = { id: "staff-marco", displayName: "Marco" };

function appointment(overrides: Record<string, unknown>) {
  return {
    id: "app-x",
    startsAt: new Date("2026-01-01T08:00:00.000Z"),
    endsAt: new Date("2026-01-01T09:30:00.000Z"),
    status: "completed",
    notes: null,
    serviceId: "svc-balayage",
    staffId: sara.id,
    service: service("balayage-straehnen", 12_000),
    staff: sara,
    payments: [],
    ...overrides,
  };
}

/** startsAt descending, the order `orderBy: { startsAt: "desc" }` produces. */
const appointments = [
  appointment({
    id: "app-next",
    startsAt: new Date("2026-08-05T08:00:00.000Z"),
    endsAt: new Date("2026-08-05T10:00:00.000Z"),
    status: "confirmed",
  }),
  appointment({
    id: "app-4",
    startsAt: new Date("2026-06-10T08:00:00.000Z"),
    endsAt: new Date("2026-06-10T10:00:00.000Z"),
    payments: [{ amountCents: 3_600, tipCents: 500, refundedCents: 0, status: "paid" }],
  }),
  appointment({
    id: "app-3",
    startsAt: new Date("2026-04-15T08:00:00.000Z"),
    endsAt: new Date("2026-04-15T10:00:00.000Z"),
    payments: [{ amountCents: 3_600, tipCents: 0, refundedCents: 0, status: "paid" }],
  }),
  appointment({
    id: "app-2",
    startsAt: new Date("2026-02-20T08:00:00.000Z"),
    endsAt: new Date("2026-02-20T09:00:00.000Z"),
    serviceId: "svc-cut",
    staffId: marco.id,
    staff: marco,
    service: service("damen-schnitt", 5_500),
  }),
  appointment({
    id: "app-1",
    startsAt: new Date("2025-12-10T08:00:00.000Z"),
    endsAt: new Date("2025-12-10T10:00:00.000Z"),
    status: "no_show",
  }),
  appointment({
    id: "app-0",
    startsAt: new Date("2025-10-01T08:00:00.000Z"),
    endsAt: new Date("2025-10-01T10:00:00.000Z"),
  }),
];

function note(overrides: Partial<Omit<NoteShape, "kind">> & { kind?: CustomerNoteKind }): NoteShape {
  return {
    id: "note-x",
    customerId: customer.id,
    note: "",
    kind: "general" as CustomerNoteKind,
    authorId: null,
    pinned: false,
    createdAt: new Date("2026-01-05T10:00:00.000Z"),
    updatedAt: new Date("2026-01-05T10:00:00.000Z"),
    ...overrides,
  };
}

const formulaNewer = note({
  id: "note-formula-new",
  kind: "formula",
  createdAt: new Date("2026-06-10T11:00:00.000Z"),
  note: serializeFormula({
    product: "Igora Royal 7-77",
    developer: "6%",
    ratio: "1:1",
    processingMinutes: 35,
    result: "kupfer, Ansatz gedeckt",
  }),
});

const formulaOlder = note({
  id: "note-formula-old",
  kind: "formula",
  createdAt: new Date("2026-04-16T11:00:00.000Z"),
  note: serializeFormula({
    product: "Igora Royal 6-46",
    developer: "9%",
    appliedAt: "2026-04-15T09:00:00.000Z",
  }),
});

/** Deliberately NOT pinned: an allergy must surface without anyone remembering to pin it. */
const allergyNote = note({
  id: "note-allergy",
  kind: "allergy",
  pinned: false,
  note: "PPD-Allergie, keine dunklen Oxidationsfarben",
  createdAt: new Date("2025-05-01T10:00:00.000Z"),
});

const preferenceNote = note({
  id: "note-pref",
  kind: "preference",
  pinned: true,
  note: "Sitzt lieber am hinteren Platz",
  createdAt: new Date("2026-03-01T10:00:00.000Z"),
});

const generalNote = note({ id: "note-general", note: "Kommt meist funf Minuten zu spat" });

/** `orderBy: [{ pinned: "desc" }, { createdAt: "desc" }]`. */
const notes = [preferenceNote, formulaNewer, formulaOlder, generalNote, allergyNote];

const historyService = new CustomerHistoryService();

beforeEach(() => {
  vi.clearAllMocks();
  customers.clear();
  customers.set(customer.id, { ...customer });
  db.customerNote.findMany.mockResolvedValue(notes);
  db.appointment.findMany.mockResolvedValue(appointments);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("customer profile aggregation", () => {
  it("aggregates two years of history into one card", async () => {
    const profile = await historyService.getCustomerProfile(customer.id, { now: NOW });

    expect(profile.customer.locale).toBe("it");
    expect(profile.stats.visitCount).toBe(4);
    expect(profile.stats.noShowCount).toBe(1);
    expect(profile.stats.cancelledCount).toBe(0);
    expect(profile.stats.noShowRate).toBe(0.2);

    // 12000 + 12000 + 5500 + 12000 completed at list price, plus the 500 tip.
    expect(profile.stats.lifetimeValueCents).toBe(42_000);
    expect(profile.stats.paidOnlineCents).toBe(7_700);
    expect(profile.stats.tipsCents).toBe(500);

    // 142 + 54 + 56 days between the four completed visits.
    expect(profile.stats.averageIntervalDays).toBe(84);
    expect(profile.stats.daysSinceLastVisit).toBe(49);
    expect(profile.stats.dueForRebooking).toBe(false);

    expect(profile.lastVisit?.appointmentId).toBe("app-4");
    expect(profile.nextAppointment?.appointmentId).toBe("app-next");
    expect(profile.stats.upcomingCount).toBe(1);
    expect(profile.recentVisits.map((visit) => visit.appointmentId)).toEqual([
      "app-4",
      "app-3",
      "app-2",
      "app-1",
      "app-0",
    ]);
  });

  it("derives the preferred stylist and service from what was actually booked", async () => {
    const profile = await historyService.getCustomerProfile(customer.id, { now: NOW });

    expect(profile.preferredStaff).toMatchObject({
      staffId: "staff-sara",
      displayName: "Sara",
      visits: 3,
      share: 0.75,
    });
    expect(profile.preferredService).toMatchObject({
      slug: "balayage-straehnen",
      name: "Balayage & Meches",
      visits: 3,
    });
  });

  it("renders every timestamp in the salon zone and not in UTC", async () => {
    const profile = await historyService.getCustomerProfile(customer.id, { now: NOW });

    // 08:00Z on a June day is 10:00 in Brixen; a server-zone format would say 08:00.
    expect(profile.stats.lastVisitLabel).toContain("10:00");
    expect(profile.stats.lastVisitLabel).toContain("2026");
    expect(profile.lastVisit?.timeLabel).toContain("10:00");
  });

  it("only asks the database for appointments of this customer", async () => {
    await historyService.getCustomerProfile(customer.id, { now: NOW });
    expect(db.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: customer.id } }),
    );
  });
});

describe("allergy visibility", () => {
  it("surfaces an unpinned allergy note anyway", async () => {
    const profile = await historyService.getCustomerProfile(customer.id, { now: NOW });

    expect(profile.hasAllergies).toBe(true);
    expect(profile.allergies.map((entry) => entry.id)).toEqual(["note-allergy"]);
    expect(profile.pinned.map((entry) => entry.id)).toEqual(["note-pref"]);
    expect(profile.notes.map((entry) => entry.id)).not.toContain("note-allergy");
    expect(profile.noteCounts).toMatchObject({ total: 5, allergy: 1, formula: 2 });
  });

  it("forces a new allergy note to be pinned and audits it", async () => {
    db.customerNote.create.mockResolvedValue(
      note({ id: "note-new", kind: "allergy", pinned: true, note: "Nickelallergie" }),
    );

    await historyService.addNote({
      customerId: customer.id,
      note: "Nickelallergie",
      kind: "allergy",
      pinned: false,
      actor: { userId: "user-1", email: "simona@hairsimo.it", role: "owner" },
    });

    expect(db.customerNote.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "allergy", pinned: true, authorId: "user-1" }),
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "customer.note.allergy.created" }),
      }),
    );
  });

  it("refuses to unpin an allergy note", async () => {
    db.customerNote.findUnique.mockResolvedValue({
      ...allergyNote,
      customer: { deletedAt: null, anonymizedAt: null },
    });

    await expect(
      historyService.updateNote("note-allergy", { pinned: false }),
    ).rejects.toThrow("ALLERGY_NOTE_MUST_STAY_PINNED");
    expect(db.customerNote.update).not.toHaveBeenCalled();
  });

  it("refuses to delete an allergy note without an explicit confirmation", async () => {
    db.customerNote.findUnique.mockResolvedValue(allergyNote);

    await expect(historyService.deleteNote("note-allergy")).rejects.toThrow(
      "ALLERGY_NOTE_DELETE_NOT_CONFIRMED",
    );
    expect(db.customerNote.delete).not.toHaveBeenCalled();

    await historyService.deleteNote("note-allergy", {
      confirmAllergyDeletion: true,
      actor: { email: "simona@hairsimo.it", role: "owner" },
    });
    expect(db.customerNote.delete).toHaveBeenCalledWith({ where: { id: "note-allergy" } });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "customer.note.allergy.deleted" }),
      }),
    );
  });
});

describe("colour formulas", () => {
  it("stores a formula as queryable JSON inside the note column", async () => {
    db.customerNote.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        note({ id: "note-fresh", kind: "formula", ...data }),
    );

    const record = await historyService.recordFormula(customer.id, {
      product: "Igora Royal 8-0",
      developer: "6%",
      ratio: "1:1",
      processingMinutes: 30,
      result: "naturblond",
    });

    const created = db.customerNote.create.mock.calls[0][0] as {
      data: { note: string; kind: string };
    };
    expect(created.data.kind).toBe("formula");
    const stored = JSON.parse(created.data.note);
    expect(stored).toMatchObject({
      v: 1,
      product: "Igora Royal 8-0",
      developer: "6%",
      ratio: "1:1",
      processingMinutes: 30,
    });
    expect(stored.text).toBe("Igora Royal 8-0 | 6% | 1:1 | 30 min | naturblond");
    expect(record.summary).toBe(stored.text);
  });

  it("returns the most recent formula by the date it was applied", async () => {
    const backdated = note({
      id: "note-formula-backdated",
      kind: "formula",
      createdAt: new Date("2026-06-20T11:00:00.000Z"),
      note: serializeFormula({
        product: "Igora Royal 5-0",
        appliedAt: "2026-01-05T09:00:00.000Z",
      }),
    });
    db.customerNote.findMany.mockResolvedValue([backdated, formulaNewer, formulaOlder]);

    const latest = await historyService.getLatestFormula(customer.id, { locale: "de" });
    expect(latest?.product).toBe("Igora Royal 7-77");
    expect(latest?.processingMinutes).toBe(35);
    expect(latest?.developer).toBe("6%");

    const all = await historyService.listFormulas(customer.id);
    expect(all.map((entry) => entry.product)).toEqual([
      "Igora Royal 7-77",
      "Igora Royal 6-46",
      "Igora Royal 5-0",
    ]);
  });

  it("puts the newest formula on the profile and keeps the summary out of raw JSON", async () => {
    const profile = await historyService.getCustomerProfile(customer.id, { now: NOW });
    expect(profile.latestFormula?.product).toBe("Igora Royal 7-77");
    expect(profile.formulaHistory).toHaveLength(2);
    const formulaView = profile.notes.find((entry) => entry.id === "note-formula-new");
    expect(formulaView?.text).not.toContain("{");
    expect(formulaView?.raw).toContain("{");
  });

  it("still reads a formula note that was hand typed before the JSON envelope", async () => {
    const legacy = note({ id: "note-legacy", kind: "formula", note: "6-46 + 9% 1:1.5" });
    const record = parseFormulaNote(legacy, "de");
    expect(record?.product).toBe("6-46 + 9% 1:1.5");
    expect(record?.version).toBe(0);
  });
});

describe("erased customers", () => {
  it("does not surface an anonymised customer in a profile lookup", async () => {
    customers.set(customer.id, { ...customer, anonymizedAt: new Date("2026-07-01T00:00:00.000Z") });
    await expect(historyService.getCustomerProfile(customer.id)).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );
    expect(db.appointment.findMany).not.toHaveBeenCalled();
  });

  it("does not surface a soft deleted customer either", async () => {
    customers.set(customer.id, { ...customer, deletedAt: new Date("2026-07-01T00:00:00.000Z") });
    await expect(historyService.getCustomerProfile(customer.id)).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );
  });

  it("refuses to write notes or formulas for an erased customer", async () => {
    customers.set(customer.id, { ...customer, anonymizedAt: new Date("2026-07-01T00:00:00.000Z") });

    await expect(
      historyService.addNote({ customerId: customer.id, note: "hallo" }),
    ).rejects.toThrow("CUSTOMER_NOT_FOUND");
    await expect(
      historyService.recordFormula(customer.id, { product: "Igora 6-46" }),
    ).rejects.toThrow("CUSTOMER_NOT_FOUND");
    expect(db.customerNote.create).not.toHaveBeenCalled();
  });

  it("refuses to edit a note belonging to an erased customer", async () => {
    db.customerNote.findUnique.mockResolvedValue({
      ...generalNote,
      customer: { deletedAt: null, anonymizedAt: new Date("2026-07-01T00:00:00.000Z") },
    });
    await expect(
      historyService.updateNote("note-general", { note: "neu" }),
    ).rejects.toThrow("CUSTOMER_NOT_FOUND");
    expect(db.customerNote.update).not.toHaveBeenCalled();
  });
});
