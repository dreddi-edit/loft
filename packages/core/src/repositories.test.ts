import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@hair-simo/db";
import {
  conflictWindowFilter,
  invalidateBlockingBounds,
  isSerializationConflict,
  readBlockingBounds,
  salonRepository,
  serializationBackoffMs,
  withSerializationRetry,
} from "./repositories";

const PREFIX = "__repotest__";
const DB_TIMEOUT = 20_000;
const MINUTE = 60_000;

/** Shape of PrismaClientKnownRequestError as far as the retry predicate cares. */
class KnownRequestError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = code;
  }
}

/** A mid-statement deadlock: Prisma 6.19.3 drops the code and keeps only the SQLSTATE. */
const DEADLOCK_MESSAGE = [
  "Invalid `prisma.appointment.create()` invocation:",
  "Error occurred during query execution:",
  "ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError {",
  'code: "40P01", message: "deadlock detected", severity: "ERROR" }), transient: false })',
].join("\n");

const WRITE_CONFLICT_MESSAGE =
  "Transaction failed due to a write conflict or a deadlock. Please retry your transaction";

describe("isSerializationConflict", () => {
  it("accepts the P2034 Prisma raises for both mid-statement and commit-time 40001", () => {
    expect(isSerializationConflict(new KnownRequestError("P2034", WRITE_CONFLICT_MESSAGE))).toBe(
      true,
    );
  });

  it("accepts a deadlock that arrives with no code and only a SQLSTATE in the message", () => {
    expect(isSerializationConflict(new Error(DEADLOCK_MESSAGE))).toBe(true);
  });

  it("accepts a bare 40001 serialization failure surfaced as an unknown request error", () => {
    const error = new Error(
      'QueryError(PostgresError { code: "40001", message: "could not serialize access ' +
        'due to read/write dependencies among transactions" })',
    );
    expect(isSerializationConflict(error)).toBe(true);
  });

  it("never retries a real SLOT_NOT_AVAILABLE", () => {
    expect(isSerializationConflict(new Error("SLOT_NOT_AVAILABLE"))).toBe(false);
  });

  it("never retries other Prisma failures", () => {
    expect(
      isSerializationConflict(new KnownRequestError("P2002", "Unique constraint failed")),
    ).toBe(false);
    expect(isSerializationConflict(new KnownRequestError("P2025", "Record not found"))).toBe(false);
  });

  it("ignores non-errors", () => {
    expect(isSerializationConflict(null)).toBe(false);
    expect(isSerializationConflict(undefined)).toBe(false);
    expect(isSerializationConflict("40001")).toBe(false);
  });
});

describe("serializationBackoffMs", () => {
  it("grows exponentially and stays inside the jitter band", () => {
    expect(serializationBackoffMs(0, () => 0)).toBe(10);
    expect(serializationBackoffMs(0, () => 1)).toBe(20);
    expect(serializationBackoffMs(1, () => 1)).toBe(40);
    expect(serializationBackoffMs(2, () => 1)).toBe(80);
  });

  it("clamps at the ceiling so a hot slot cannot back off forever", () => {
    expect(serializationBackoffMs(30, () => 1)).toBe(400);
    expect(serializationBackoffMs(30, () => 0)).toBe(200);
  });
});

describe("withSerializationRetry", () => {
  it("retries a simulated P2034 and returns the eventual success", async () => {
    const run = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new KnownRequestError("P2034", WRITE_CONFLICT_MESSAGE))
      .mockRejectedValueOnce(new Error(DEADLOCK_MESSAGE))
      .mockResolvedValueOnce("appointment-1");

    await expect(withSerializationRetry(run)).resolves.toBe("appointment-1");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("gives up after the bounded number of attempts and rethrows the conflict", async () => {
    const conflict = new KnownRequestError("P2034", WRITE_CONFLICT_MESSAGE);
    const run = vi.fn<(attempt: number) => Promise<never>>().mockRejectedValue(conflict);

    await expect(withSerializationRetry(run, 3)).rejects.toBe(conflict);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("passes SLOT_NOT_AVAILABLE straight through without a second attempt", async () => {
    const run = vi
      .fn<(attempt: number) => Promise<never>>()
      .mockRejectedValue(new Error("SLOT_NOT_AVAILABLE"));

    await expect(withSerializationRetry(run)).rejects.toThrow("SLOT_NOT_AVAILABLE");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("conflictWindowFilter", () => {
  const startsAt = new Date("2026-08-04T08:00:00.000Z");
  const blockedEndsAt = new Date("2026-08-04T09:10:00.000Z");

  it("bounds the scan below by the longest possible service plus its buffer", () => {
    const filter = conflictWindowFilter(startsAt, blockedEndsAt, {
      spanMinutes: 160,
      bufferMinutes: 10,
    });

    expect(filter.startsAt.gte.toISOString()).toBe("2026-08-04T05:20:00.000Z");
    expect(filter.startsAt.lt).toBe(blockedEndsAt);
    expect(filter.endsAt.gt.toISOString()).toBe("2026-08-04T07:50:00.000Z");
  });

  it("degenerates to the slot itself when the catalogue is empty", () => {
    const filter = conflictWindowFilter(startsAt, blockedEndsAt, {
      spanMinutes: 0,
      bufferMinutes: 0,
    });

    expect(filter.startsAt.gte.getTime()).toBe(startsAt.getTime());
    expect(filter.endsAt.gt.getTime()).toBe(startsAt.getTime());
  });

  it("keeps a long appointment that starts before the slot inside the window", () => {
    const bounds = { spanMinutes: 160, bufferMinutes: 10 };
    const filter = conflictWindowFilter(startsAt, blockedEndsAt, bounds);
    const longestPossibleConflict = new Date(startsAt.getTime() - 159 * MINUTE);

    expect(longestPossibleConflict >= filter.startsAt.gte).toBe(true);
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

let counter = 0;

async function createFixture(options?: { durationMin?: number; bufferAfterMin?: number }) {
  counter += 1;
  const tag = `${PREFIX}${Date.now().toString(36)}_${counter}`;

  const service = await prisma.service.create({
    data: {
      slug: `${tag}-service`,
      category: "test",
      durationMin: options?.durationMin ?? 60,
      bufferAfterMin: options?.bufferAfterMin ?? 10,
      priceCents: 5_000,
      translations: {
        create: [{ locale: "de", name: `${tag} Haarschnitt`, description: "fixture" }],
      },
    },
  });

  const user = await prisma.user.create({
    data: {
      email: `${tag}-staff@example.invalid`,
      passwordHash: "not-a-real-hash",
      firstName: "Fixture",
      lastName: PREFIX,
      locale: "de",
      staffProfile: {
        create: { displayName: `${tag} Stylist`, locale: "de", isBookable: true },
      },
    },
    include: { staffProfile: true },
  });
  const staff = user.staffProfile;
  if (!staff) throw new Error("fixture staff profile missing");

  await prisma.staffService.create({ data: { staffId: staff.id, serviceId: service.id } });

  const customer = await prisma.customer.create({
    data: {
      email: `${tag}-customer@example.invalid`,
      firstName: "Fixture",
      lastName: PREFIX,
      locale: "de",
      sourceChannel: "web",
    },
  });

  invalidateBlockingBounds();
  return { tag, service, staff, customer };
}

async function cleanup() {
  await prisma.appointment.deleteMany({ where: { customer: { lastName: PREFIX } } });
  await prisma.waitlist.deleteMany({ where: { customer: { lastName: PREFIX } } });
  await prisma.customer.deleteMany({ where: { lastName: PREFIX } });
  await prisma.staffService.deleteMany({ where: { service: { slug: { startsWith: PREFIX } } } });
  await prisma.service.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { entityType: { startsWith: PREFIX } } });
  invalidateBlockingBounds();
}

function bookingInput(fixture: Fixture, startsAt: Date) {
  const endsAt = new Date(startsAt.getTime() + fixture.service.durationMin * MINUTE);
  return {
    customerId: fixture.customer.id,
    serviceId: fixture.service.id,
    staffId: fixture.staff.id,
    startsAt,
    endsAt,
    blockedEndsAt: new Date(endsAt.getTime() + fixture.service.bufferAfterMin * MINUTE),
    locale: "de",
    sourceChannel: "web" as const,
  };
}

const canReachDatabase = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!canReachDatabase)("repositories against the live database", () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("readBlockingBounds", () => {
    it(
      "derives the window from the catalogue instead of a hard-coded constant",
      async () => {
        const before = await readBlockingBounds(prisma);
        const fixture = await createFixture({ durationMin: 999, bufferAfterMin: 45 });
        const after = await readBlockingBounds(prisma);

        expect(after.bufferMinutes).toBeGreaterThanOrEqual(45);
        expect(after.spanMinutes).toBeGreaterThanOrEqual(999 + 45);
        expect(after.spanMinutes).toBeGreaterThan(before.spanMinutes);
        expect(fixture.service.durationMin).toBe(999);
      },
      DB_TIMEOUT,
    );
  });

  describe("createAppointmentIfAvailable", () => {
    it(
      "books a free slot",
      async () => {
        const fixture = await createFixture();
        const startsAt = new Date(Date.now() + 40 * 24 * 3_600_000);
        const appointment = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, startsAt),
        );

        expect(appointment.staffId).toBe(fixture.staff.id);
        expect(appointment.status).toBe("pending");
      },
      DB_TIMEOUT,
    );

    it(
      "rejects a directly overlapping second booking",
      async () => {
        const fixture = await createFixture();
        const startsAt = new Date(Date.now() + 41 * 24 * 3_600_000);
        await salonRepository.createAppointmentIfAvailable(bookingInput(fixture, startsAt));

        await expect(
          salonRepository.createAppointmentIfAvailable(bookingInput(fixture, startsAt)),
        ).rejects.toThrow("SLOT_NOT_AVAILABLE");
      },
      DB_TIMEOUT,
    );

    it(
      "still sees a long appointment that starts well before the requested slot",
      async () => {
        const fixture = await createFixture({ durationMin: 150, bufferAfterMin: 10 });
        const target = new Date(Date.now() + 42 * 24 * 3_600_000);
        const earlier = new Date(target.getTime() - 140 * MINUTE);

        await salonRepository.createAppointmentIfAvailable(bookingInput(fixture, earlier));

        await expect(
          salonRepository.createAppointmentIfAvailable(bookingInput(fixture, target)),
        ).rejects.toThrow("SLOT_NOT_AVAILABLE");
      },
      DB_TIMEOUT,
    );

    it(
      "ignores history far outside the derived window",
      async () => {
        const fixture = await createFixture();
        const ancient = new Date(Date.now() - 400 * 24 * 3_600_000);
        await salonRepository.createAppointmentIfAvailable(bookingInput(fixture, ancient));

        const startsAt = new Date(Date.now() + 43 * 24 * 3_600_000);
        const appointment = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, startsAt),
        );
        expect(appointment.startsAt.getTime()).toBe(startsAt.getTime());
      },
      DB_TIMEOUT,
    );

    it(
      "frees the slot again once the appointment is cancelled",
      async () => {
        const fixture = await createFixture();
        const startsAt = new Date(Date.now() + 44 * 24 * 3_600_000);
        const first = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, startsAt),
        );
        await salonRepository.updateAppointmentStatus(first.id, "cancelled", "test");

        const second = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, startsAt),
        );
        expect(second.id).not.toBe(first.id);
      },
      DB_TIMEOUT,
    );
  });

  describe("listBlockedAppointments", () => {
    it(
      "returns the blocking appointment and drops cancelled ones",
      async () => {
        const fixture = await createFixture();
        const startsAt = new Date(Date.now() + 45 * 24 * 3_600_000);
        const created = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, startsAt),
        );

        const windowStart = new Date(startsAt.getTime() - 30 * MINUTE);
        const windowEnd = new Date(startsAt.getTime() + 4 * 3_600_000);

        const blocked = await salonRepository.listBlockedAppointments(
          fixture.staff.id,
          windowStart,
          windowEnd,
        );
        expect(blocked.map((entry) => entry.id)).toContain(created.id);

        await salonRepository.updateAppointmentStatus(created.id, "cancelled", "test");
        const afterCancel = await salonRepository.listBlockedAppointments(
          fixture.staff.id,
          windowStart,
          windowEnd,
        );
        expect(afterCancel.map((entry) => entry.id)).not.toContain(created.id);
      },
      DB_TIMEOUT,
    );
  });

  describe("rescheduleAppointmentIfAvailable", () => {
    it(
      "moves an appointment and refuses a slot another booking already blocks",
      async () => {
        const fixture = await createFixture();
        const slotA = new Date(Date.now() + 46 * 24 * 3_600_000);
        const slotB = new Date(slotA.getTime() + 6 * 3_600_000);
        const slotC = new Date(slotA.getTime() + 12 * 3_600_000);

        const first = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, slotA),
        );
        const second = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, slotB),
        );

        const movedInput = bookingInput(fixture, slotC);
        const moved = await salonRepository.rescheduleAppointmentIfAvailable(
          second.id,
          fixture.staff.id,
          movedInput.startsAt,
          movedInput.endsAt,
          movedInput.blockedEndsAt,
        );
        expect(moved.startsAt.getTime()).toBe(slotC.getTime());
        expect(moved.status).toBe("confirmed");

        const clash = bookingInput(fixture, slotA);
        await expect(
          salonRepository.rescheduleAppointmentIfAvailable(
            moved.id,
            fixture.staff.id,
            clash.startsAt,
            clash.endsAt,
            clash.blockedEndsAt,
          ),
        ).rejects.toThrow("SLOT_NOT_AVAILABLE");
        expect(first.id).toBeTruthy();
      },
      DB_TIMEOUT,
    );
  });

  describe("soft-deleted customers", () => {
    it(
      "hides them from listCustomers and findCustomerById unless asked for",
      async () => {
        const fixture = await createFixture();
        await salonRepository.softDeleteCustomer(fixture.customer.id);

        const listed = await salonRepository.listCustomers({ query: fixture.tag });
        expect(listed).toHaveLength(0);

        const withDeleted = await salonRepository.listCustomers({
          query: fixture.tag,
          includeDeleted: true,
        });
        expect(withDeleted.map((entry) => entry.id)).toEqual([fixture.customer.id]);

        expect(await salonRepository.findCustomerById(fixture.customer.id)).toBeNull();
        const found = await salonRepository.findCustomerById(fixture.customer.id, {
          includeDeleted: true,
        });
        expect(found?.id).toBe(fixture.customer.id);
      },
      DB_TIMEOUT,
    );

    it(
      "refuses to resurrect an erased customer through the booking path",
      async () => {
        const fixture = await createFixture();
        const email = fixture.customer.email;
        if (!email) throw new Error("fixture customer email missing");
        await salonRepository.softDeleteCustomer(fixture.customer.id);

        await expect(
          salonRepository.findOrCreateCustomerByEmail(email, "de", "web", { firstName: "Mallory" }),
        ).rejects.toThrow("CUSTOMER_DELETED");

        const untouched = await prisma.customer.findUniqueOrThrow({
          where: { id: fixture.customer.id },
        });
        expect(untouched.firstName).toBe("Fixture");
        expect(untouched.deletedAt).not.toBeNull();
      },
      DB_TIMEOUT,
    );

    it(
      "restores only when the caller opts in explicitly",
      async () => {
        const fixture = await createFixture();
        const email = fixture.customer.email;
        if (!email) throw new Error("fixture customer email missing");
        await salonRepository.softDeleteCustomer(fixture.customer.id);

        const restored = await salonRepository.findOrCreateCustomerByEmail(
          email,
          "it",
          "whatsapp",
          { firstName: "Elena" },
          { restoreDeleted: true },
        );
        expect(restored.deletedAt).toBeNull();
        expect(restored.firstName).toBe("Elena");
        expect(restored.locale).toBe("it");
      },
      DB_TIMEOUT,
    );

    it(
      "never reuses an anonymised row, even with restoreDeleted",
      async () => {
        const fixture = await createFixture();
        const email = fixture.customer.email;
        if (!email) throw new Error("fixture customer email missing");
        await prisma.customer.update({
          where: { id: fixture.customer.id },
          data: { deletedAt: new Date(), anonymizedAt: new Date() },
        });

        await expect(
          salonRepository.findOrCreateCustomerByEmail(email, "de", "web", undefined, {
            restoreDeleted: true,
          }),
        ).rejects.toThrow("CUSTOMER_ANONYMIZED");

        await expect(salonRepository.restoreCustomer(fixture.customer.id)).rejects.toThrow(
          "CUSTOMER_ANONYMIZED",
        );
      },
      DB_TIMEOUT,
    );

    it(
      "keeps working for live customers and for brand new ones",
      async () => {
        const fixture = await createFixture();
        const email = fixture.customer.email;
        if (!email) throw new Error("fixture customer email missing");

        const updated = await salonRepository.findOrCreateCustomerByEmail(email, "fr", "sms", {
          phone: `${fixture.tag}-phone`,
        });
        expect(updated.id).toBe(fixture.customer.id);
        expect(updated.locale).toBe("fr");

        const freshEmail = `${fixture.tag}-fresh@example.invalid`;
        const created = await salonRepository.findOrCreateCustomerByEmail(freshEmail, "de", "web");
        expect(created.firstName).toBe("Guest");
        await prisma.customer.update({
          where: { id: created.id },
          data: { lastName: PREFIX },
        });
      },
      DB_TIMEOUT,
    );

    it(
      "excludes soft-deleted customers from the dashboard headcount",
      async () => {
        const baseline = await salonRepository.getDashboardStats();
        const fixture = await createFixture();

        const withCustomer = await salonRepository.getDashboardStats();
        expect(withCustomer.customers).toBe(baseline.customers + 1);

        await salonRepository.softDeleteCustomer(fixture.customer.id);
        const afterDelete = await salonRepository.getDashboardStats();
        expect(afterDelete.customers).toBe(baseline.customers);
      },
      DB_TIMEOUT,
    );
  });

  describe("customer notes", () => {
    it(
      "filters by kind and puts pinned notes first",
      async () => {
        const fixture = await createFixture();
        await salonRepository.addCustomerNote(fixture.customer.id, "older general");
        await salonRepository.addCustomerNote(fixture.customer.id, "allergy: PPD", {
          kind: "allergy",
        });
        const formula = await salonRepository.addCustomerNote(
          fixture.customer.id,
          "6/0 + 9/1, 30 min",
          { kind: "formula", authorId: fixture.staff.id },
        );
        await salonRepository.addCustomerNote(fixture.customer.id, "newer general");

        const all = await salonRepository.listCustomerNotes(fixture.customer.id);
        expect(all).toHaveLength(4);
        expect(all[0].note).toBe("newer general");

        const allergies = await salonRepository.listCustomerNotes(fixture.customer.id, {
          kind: "allergy",
        });
        expect(allergies.map((note) => note.note)).toEqual(["allergy: PPD"]);

        await salonRepository.setCustomerNotePinned(formula.id, true);
        const pinnedFirst = await salonRepository.listCustomerNotes(fixture.customer.id);
        expect(pinnedFirst[0].id).toBe(formula.id);
        expect(pinnedFirst[0].kind).toBe("formula");
        expect(pinnedFirst[0].authorId).toBe(fixture.staff.id);
      },
      DB_TIMEOUT,
    );
  });

  describe("audit log", () => {
    it(
      "records an entry and filters it back out",
      async () => {
        const fixture = await createFixture();
        const entityType = `${PREFIX}Service`;

        await salonRepository.createAuditLog({
          actorEmail: "owner@example.invalid",
          actorRole: "owner",
          action: "service.update",
          entityType,
          entityId: fixture.service.id,
          before: { priceCents: 5_000 },
          after: { priceCents: 5_500 },
          ip: "203.0.113.7",
          userAgent: "vitest",
        });
        await salonRepository.createAuditLog({
          actorEmail: "manager@example.invalid",
          actorRole: "manager",
          action: "service.delete",
          entityType,
          entityId: fixture.service.id,
        });

        const all = await salonRepository.listAuditLog({ entityType });
        expect(all).toHaveLength(2);
        expect(all[0].action).toBe("service.delete");

        const filtered = await salonRepository.listAuditLog({
          entityType,
          action: "service.update",
        });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].before).toEqual({ priceCents: 5_000 });
        expect(filtered[0].after).toEqual({ priceCents: 5_500 });

        const paged = await salonRepository.listAuditLog({ entityType }, { skip: 1, take: 1 });
        expect(paged.map((entry) => entry.action)).toEqual(["service.update"]);
      },
      DB_TIMEOUT,
    );
  });

  describe("waitlist", () => {
    it(
      "matches overlapping windows and walks an entry through its lifecycle",
      async () => {
        const fixture = await createFixture();
        const day = new Date(Date.now() + 60 * 24 * 3_600_000);

        const entry = await salonRepository.createWaitlistEntry({
          customerId: fixture.customer.id,
          serviceId: fixture.service.id,
          staffId: fixture.staff.id,
          earliestAt: day,
          latestAt: new Date(day.getTime() + 8 * 3_600_000),
          locale: "de",
        });
        expect(entry.status).toBe("active");

        const overlapping = await salonRepository.listActiveWaitlistFor(fixture.service.id, {
          from: new Date(day.getTime() + 2 * 3_600_000),
          to: new Date(day.getTime() + 3 * 3_600_000),
        });
        expect(overlapping.map((item) => item.id)).toContain(entry.id);

        const disjoint = await salonRepository.listActiveWaitlistFor(fixture.service.id, {
          from: new Date(day.getTime() + 20 * 3_600_000),
          to: new Date(day.getTime() + 21 * 3_600_000),
        });
        expect(disjoint.map((item) => item.id)).not.toContain(entry.id);

        const notified = await salonRepository.markWaitlistNotified(entry.id);
        expect(notified.status).toBe("notified");
        expect(notified.notifiedAt).not.toBeNull();

        const stillActive = await salonRepository.listActiveWaitlistFor(fixture.service.id, {
          from: day,
          to: new Date(day.getTime() + 8 * 3_600_000),
        });
        expect(stillActive.map((item) => item.id)).not.toContain(entry.id);

        const appointment = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, new Date(day.getTime() + 3 * 3_600_000)),
        );
        const converted = await salonRepository.markWaitlistConverted(entry.id, appointment.id);
        expect(converted.status).toBe("converted");
        expect(converted.convertedAppointmentId).toBe(appointment.id);
      },
      DB_TIMEOUT,
    );

    it(
      "expires entries whose window has passed",
      async () => {
        const fixture = await createFixture();
        const past = new Date(Date.now() - 10 * 24 * 3_600_000);

        const stale = await salonRepository.createWaitlistEntry({
          customerId: fixture.customer.id,
          serviceId: fixture.service.id,
          earliestAt: new Date(past.getTime() - 3_600_000),
          latestAt: past,
        });
        const future = await salonRepository.createWaitlistEntry({
          customerId: fixture.customer.id,
          serviceId: fixture.service.id,
          earliestAt: new Date(Date.now() + 3_600_000),
          latestAt: new Date(Date.now() + 2 * 3_600_000),
        });

        await salonRepository.expireWaitlistBefore(new Date());

        expect((await prisma.waitlist.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
          "expired",
        );
        expect((await prisma.waitlist.findUniqueOrThrow({ where: { id: future.id } })).status).toBe(
          "active",
        );
      },
      DB_TIMEOUT,
    );
  });

  describe("getReportStats", () => {
    it(
      "buckets revenue by the salon calendar day, not the UTC day",
      async () => {
        const fixture = await createFixture();
        // 23:30 UTC on 3 November is 00:30 on 4 November in Rome (UTC+1 in winter).
        const startsAt = new Date("2019-11-03T22:00:00.000Z");
        const paidAt = new Date("2019-11-03T23:30:00.000Z");

        const appointment = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, startsAt),
        );
        await prisma.payment.create({
          data: {
            appointmentId: appointment.id,
            provider: "test",
            amountCents: 4_200,
            mode: "deposit",
            status: "paid",
            createdAt: paidAt,
          },
        });

        const report = await salonRepository.getReportStats(
          new Date("2019-11-01T00:00:00.000Z"),
          new Date("2019-11-30T00:00:00.000Z"),
        );

        expect(report.dailyRevenue).toEqual([{ label: "2019-11-04", value: 4_200 }]);
        expect(report.revenueCents).toBe(4_200);
        expect(report.paidPayments).toBe(1);
      },
      DB_TIMEOUT,
    );

    it(
      "groups service and staff breakdowns in Postgres with their revenue",
      async () => {
        const fixture = await createFixture();
        const startsAt = new Date("2019-12-10T09:00:00.000Z");
        const appointment = await salonRepository.createAppointmentIfAvailable(
          bookingInput(fixture, startsAt),
        );
        await prisma.payment.create({
          data: {
            appointmentId: appointment.id,
            provider: "test",
            amountCents: 7_100,
            mode: "full",
            status: "paid",
          },
        });
        await prisma.payment.create({
          data: {
            appointmentId: appointment.id,
            provider: "test",
            amountCents: 999,
            mode: "full",
            status: "failed",
          },
        });

        const report = await salonRepository.getReportStats(
          new Date("2019-12-01T00:00:00.000Z"),
          new Date("2019-12-31T00:00:00.000Z"),
        );

        expect(report.byService).toEqual([
          { label: `${fixture.tag} Haarschnitt`, count: 1, revenueCents: 7_100 },
        ]);
        expect(report.byStaff).toEqual([
          { label: `${fixture.tag} Stylist`, count: 1, revenueCents: 7_100 },
        ]);
        expect(report.pendingAppointments).toBe(1);
      },
      DB_TIMEOUT,
    );
  });

  describe("pagination defaults", () => {
    it(
      "never returns an unbounded customer list",
      async () => {
        await createFixture();
        const listed = await salonRepository.listCustomers({ take: 10_000 });
        expect(listed.length).toBeLessThanOrEqual(200);
      },
      DB_TIMEOUT,
    );
  });
});
