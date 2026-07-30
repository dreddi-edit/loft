import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Selection = Record<string, unknown>;

const { db, send } = vi.hoisted(() => {
  const customers: Row[] = [];
  const appointments: Row[] = [];
  const consents: Row[] = [];
  const requests: Row[] = [];
  const logs: Row[] = [];

  // Anchored to the suite's NOW. A 1970 clock makes every "now - updatedAt < window"
  // comparison trivially large and hides the retry cooldown entirely.
  const ANCHOR = Date.parse("2026-07-29T09:00:00.000Z");

  let sequence = 0;

  function tick(): Date {
    sequence += 1;
    return new Date(ANCHOR + sequence);
  }

  function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
  }

  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return comparable(actual) === expected.getTime();
    if (typeof expected === "object") {
      return Object.entries(expected as Row).every(([operator, operand]) => {
        if (operator === "in") return (operand as unknown[]).includes(actual);
        if (operator === "not") {
          if (operand === null) return actual !== null && actual !== undefined;
          return comparable(actual) !== comparable(operand);
        }
        const left = comparable(actual);
        const right = comparable(operand);
        if (typeof left !== "number" || typeof right !== "number") return false;
        if (operator === "lt") return left < right;
        if (operator === "lte") return left <= right;
        if (operator === "gt") return left > right;
        if (operator === "gte") return left >= right;
        throw new Error(`unsupported operator ${operator}`);
      });
    }
    return actual === expected;
  }

  function matchesRequest(row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === "OR") return (expected as Where[]).some((clause) => matchesRequest(row, clause));
      if (key === "appointment") {
        const linked = appointments.find((entry) => entry.id === row.appointmentId);
        return linked !== undefined && matchesAppointment(linked, expected as Where);
      }
      return matchValue(row[key], expected);
    });
  }

  function matchesAppointment(row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === "OR") {
        return (expected as Where[]).some((clause) => matchesAppointment(row, clause));
      }
      if (key === "reviewRequest") {
        const linked = requests.find((entry) => entry.appointmentId === row.id);
        const condition = (expected as { is: Where | null }).is;
        if (condition === null) return linked === undefined;
        return linked !== undefined && matchesRequest(linked, condition);
      }
      return matchValue(row[key], expected);
    });
  }

  function matchesPlain(row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, expected]) => matchValue(row[key], expected));
  }

  function orderClauses(orderBy: unknown): [string, string][] {
    if (!orderBy) return [];
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    return list.flatMap((clause) => Object.entries(clause as Row) as [string, string][]);
  }

  function sortAndTake(rows: Row[], args: Row): Row[] {
    const clauses = orderClauses(args.orderBy);
    const sorted = [...rows];
    if (clauses.length > 0) {
      sorted.sort((left, right) => {
        for (const [key, direction] of clauses) {
          const a = comparable(left[key]);
          const b = comparable(right[key]);
          if (a === b) continue;
          if (a === null || a === undefined) return 1;
          if (b === null || b === undefined) return -1;
          const delta = a < b ? -1 : 1;
          return direction === "desc" ? -delta : delta;
        }
        return 0;
      });
    }
    const take = args.take as number | undefined;
    return take === undefined ? sorted : sorted.slice(0, take);
  }

  function project(row: Row, select?: Selection): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (wanted) out[key] = row[key];
    }
    return out;
  }

  function projectAppointment(row: Row, select?: Selection): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (key === "customer") {
        const customer = customers.find((entry) => entry.id === row.customerId);
        const nested = (wanted as { select?: Selection }).select;
        out.customer = customer ? project(customer, nested) : null;
        continue;
      }
      if (wanted) out[key] = row[key];
    }
    return out;
  }

  function projectRequest(row: Row, select?: Selection): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (key === "appointment") {
        const appointment = appointments.find((entry) => entry.id === row.appointmentId);
        const nested = (wanted as { select?: Selection }).select;
        out.appointment = appointment ? project(appointment, nested) : null;
        continue;
      }
      if (wanted) out[key] = row[key];
    }
    return out;
  }

  function applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) row[key] = value;
    row.updatedAt = tick();
  }

  function uniqueViolation(): Error {
    return Object.assign(new Error("Unique constraint failed on the fields: (`appointmentId`)"), {
      code: "P2002",
    });
  }

  const consentRecord = {
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        consents.filter((row) => matchesPlain(row, args.where as Where)),
        args,
      ).map((row) => project(row, args.select as Selection | undefined)),
    ),
    findFirst: vi.fn(async (args: Row = {}) => {
      const found = sortAndTake(
        consents.filter((row) => matchesPlain(row, args.where as Where)),
        { ...args, take: 1 },
      )[0];
      return found ? project(found, args.select as Selection | undefined) : null;
    }),
  };

  const appointment = {
    findUnique: vi.fn(async (args: { where: Where; select?: Selection }) => {
      const found = appointments.find((row) => matchesAppointment(row, args.where));
      return found ? projectAppointment(found, args.select) : null;
    }),
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        appointments.filter((row) => matchesAppointment(row, args.where as Where)),
        args,
      ).map((row) => projectAppointment(row, args.select as Selection | undefined)),
    ),
  };

  const reviewRequest = {
    create: vi.fn(async (args: { data: Row; select?: Selection }) => {
      if (requests.some((row) => row.appointmentId === args.data.appointmentId)) {
        throw uniqueViolation();
      }
      sequence += 1;
      const stamp = tick();
      const row: Row = {
        id: `request-${sequence}`,
        sentAt: null,
        clickedAt: null,
        platform: "google",
        createdAt: stamp,
        updatedAt: stamp,
        ...args.data,
      };
      requests.push(row);
      return projectRequest(row, args.select);
    }),
    findUnique: vi.fn(async (args: { where: Where; select?: Selection }) => {
      const found = requests.find((row) => matchesRequest(row, args.where));
      return found ? projectRequest(found, args.select) : null;
    }),
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        requests.filter((row) => matchesRequest(row, args.where as Where)),
        args,
      ).map((row) => projectRequest(row, args.select as Selection | undefined)),
    ),
    update: vi.fn(async (args: { where: Where; data: Row }) => {
      const row = requests.find((entry) => matchesRequest(entry, args.where));
      if (!row) throw Object.assign(new Error("No ReviewRequest found"), { code: "P2025" });
      applyData(row, args.data);
      return { ...row };
    }),
    updateMany: vi.fn(async (args: { where: Where; data: Row }) => {
      const targets = requests.filter((row) => matchesRequest(row, args.where));
      for (const row of targets) applyData(row, args.data);
      return { count: targets.length };
    }),
  };

  const notificationLog = {
    create: vi.fn(async (args: { data: Row }) => {
      sequence += 1;
      const row: Row = { id: `log-${sequence}`, createdAt: tick(), ...args.data };
      logs.push(row);
      return { ...row };
    }),
  };

  return {
    send: vi.fn(),
    db: {
      prisma: { consentRecord, appointment, reviewRequest, notificationLog },
      customers,
      appointments,
      consents,
      requests,
      logs,
      nextId() {
        sequence += 1;
        return sequence;
      },
      reset() {
        customers.length = 0;
        appointments.length = 0;
        consents.length = 0;
        requests.length = 0;
        logs.length = 0;
        sequence = 0;
      },
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
 prisma: db.prisma }));

vi.mock("./notification-service", () => ({
  NotificationService: class {
    send = send;
  },
}));

import {
  DEFAULT_REVIEWED_COOLDOWN_DAYS,
  DEFAULT_REVIEW_COOLDOWN_DAYS,
  DEFAULT_REVIEW_DELAY_HOURS,
  DEFAULT_REVIEW_LIFETIME_CAP,
  DEFAULT_REVIEW_MAX_AGE_DAYS,
  REVIEW_RETRY_AFTER_MINUTES,
  REVIEW_TEMPLATE_KEY,
  ReviewRequestService,
  buildPlatformReviewUrl,
  buildReviewUrl,
  createReviewToken,
  verifyReviewToken,
} from "./review-request-service";

const NOW = new Date("2026-07-29T09:00:00.000Z");
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const originalEnv = { ...process.env };
let service: ReviewRequestService;

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * MS_PER_HOUR);
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function seedCustomer(overrides: Row = {}): string {
  const id = (overrides.id as string) ?? `customer-${db.customers.length + 1}`;
  db.customers.push({
    id,
    firstName: "Anna",
    email: "anna@example.com",
    phone: null,
    locale: "de",
    marketingOptIn: true,
    deletedAt: null,
    anonymizedAt: null,
    ...overrides,
  });
  return id;
}

function seedAppointment(overrides: Row = {}): string {
  const id = (overrides.id as string) ?? `appointment-${db.appointments.length + 1}`;
  const customerId = (overrides.customerId as string) ?? seedCustomer();
  db.appointments.push({
    id,
    customerId,
    status: "completed",
    endsAt: hoursAgo(4),
    locale: "de",
    ...overrides,
  });
  return id;
}

function seedConsent(customerId: string, type: string, granted: boolean, createdAt: Date): string {
  const id = `consent-${String(db.consents.length + 1).padStart(3, "0")}`;
  db.consents.push({ id, customerId, type, granted, createdAt, updatedAt: createdAt });
  return id;
}

function seedRequest(overrides: Row = {}): Row {
  const row: Row = {
    id: (overrides.id as string) ?? `request-seed-${db.requests.length + 1}`,
    appointmentId: null,
    sentAt: null,
    clickedAt: null,
    platform: "google",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...overrides,
  };
  db.requests.push(row);
  return row;
}

function requestFor(appointmentId: string): Row {
  const row = db.requests.find((entry) => entry.appointmentId === appointmentId);
  if (!row) throw new Error(`no review request for ${appointmentId}`);
  return row;
}

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  send.mockReset();
  send.mockResolvedValue({ status: "sent", provider: "gmail", messageId: "message-1" });
  process.env.REVIEW_LINK_SECRET = "review-link-secret-for-tests-0000";
  process.env.NEXT_PUBLIC_BASE_URL = "https://hairsimo.it/";
  process.env.GOOGLE_MAPS_PLACE_ID = "ChIJhairsimo";
  delete process.env.GOOGLE_REVIEW_URL;
  process.env.NODE_ENV = "test";
  service = new ReviewRequestService();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("eligibility", () => {
  it("asks once, in the appointment locale, and records what went out", async () => {
    const appointmentId = seedAppointment({ locale: "it" });

    const outcome = await service.scheduleForCompleted(appointmentId, { now: NOW });

    expect(outcome.status).toBe("sent");
    if (outcome.status === "skipped") throw new Error("expected a send");
    expect(outcome.url).toBe(`https://hairsimo.it/api/review/${createReviewToken(outcome.requestId)}`);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      channel: "web",
      recipient: "anna@example.com",
      locale: "it",
    });
    expect(send.mock.calls[0]?.[0].subject).toContain("Hair Simo");
    expect(send.mock.calls[0]?.[0].message).toContain(outcome.url);
    expect(send.mock.calls[0]?.[0].message).toContain("Anna");

    expect(requestFor(appointmentId).sentAt).toEqual(NOW);
    expect(db.logs).toHaveLength(1);
    expect(db.logs[0]).toMatchObject({
      appointmentId,
      channel: "web",
      templateKey: REVIEW_TEMPLATE_KEY,
      status: "sent",
      attempts: 1,
      lastError: null,
      sentAt: NOW,
    });
  });

  it("falls back to sms when the customer left only a phone number", async () => {
    const customerId = seedCustomer({ email: null, phone: " +39 340 1234567 " });
    const appointmentId = seedAppointment({ customerId });

    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toMatchObject({
      status: "sent",
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      channel: "sms",
      recipient: "+39 340 1234567",
    });
  });

  it("only ever asks about a completed visit", async () => {
    for (const status of ["pending", "confirmed", "cancelled", "no_show"]) {
      db.reset();
      const appointmentId = seedAppointment({ status });
      await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toEqual({
        status: "skipped",
        appointmentId,
        reason: "NOT_COMPLETED",
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(db.requests).toHaveLength(0);
  });

  it("waits out the delay and then stops asking once the visit is stale", async () => {
    expect(DEFAULT_REVIEW_DELAY_HOURS).toBe(3);
    expect(DEFAULT_REVIEW_MAX_AGE_DAYS).toBe(14);

    const tooSoon = seedAppointment({
      id: "too-soon",
      endsAt: new Date(NOW.getTime() - 3 * MS_PER_HOUR + 1),
    });
    const justRight = seedAppointment({ id: "just-right", endsAt: hoursAgo(3) });
    const lastChance = seedAppointment({ id: "last-chance", endsAt: daysAgo(14) });
    const tooLate = seedAppointment({
      id: "too-late",
      endsAt: new Date(NOW.getTime() - 14 * MS_PER_DAY - 1),
    });

    await expect(service.scheduleForCompleted(tooSoon, { now: NOW })).resolves.toMatchObject({
      reason: "TOO_SOON",
    });
    await expect(service.scheduleForCompleted(tooLate, { now: NOW })).resolves.toMatchObject({
      reason: "TOO_LATE",
    });
    await expect(service.scheduleForCompleted(justRight, { now: NOW })).resolves.toMatchObject({
      status: "sent",
    });
    await expect(service.scheduleForCompleted(lastChance, { now: NOW })).resolves.toMatchObject({
      status: "sent",
    });
  });

  it("asks exactly once per appointment", async () => {
    const appointmentId = seedAppointment();

    const first = await service.scheduleForCompleted(appointmentId, { now: NOW });
    const second = await service.scheduleForCompleted(appointmentId, {
      now: new Date(NOW.getTime() + MS_PER_DAY),
    });

    expect(first.status).toBe("sent");
    expect(second).toEqual({ status: "skipped", appointmentId, reason: "ALREADY_REQUESTED" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.requests).toHaveLength(1);
    expect(db.logs).toHaveLength(1);
  });

  it("skips a customer who was erased or anonymised", async () => {
    const deleted = seedAppointment({
      id: "deleted",
      customerId: seedCustomer({ id: "customer-deleted", deletedAt: daysAgo(3) }),
    });
    const anonymised = seedAppointment({
      id: "anonymised",
      customerId: seedCustomer({ id: "customer-anon", anonymizedAt: daysAgo(3) }),
    });

    await expect(service.scheduleForCompleted(deleted, { now: NOW })).resolves.toMatchObject({
      reason: "CUSTOMER_UNAVAILABLE",
    });
    await expect(service.scheduleForCompleted(anonymised, { now: NOW })).resolves.toMatchObject({
      reason: "CUSTOMER_UNAVAILABLE",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("skips a customer with nowhere to send to, and an unknown appointment", async () => {
    const customerId = seedCustomer({ email: null, phone: "   " });
    const appointmentId = seedAppointment({ customerId });

    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toMatchObject({
      reason: "NO_CONTACT_DETAILS",
    });
    await expect(service.scheduleForCompleted("ghost", { now: NOW })).resolves.toEqual({
      status: "skipped",
      appointmentId: "ghost",
      reason: "APPOINTMENT_NOT_FOUND",
    });
  });

  it("refuses to invent a review link when the salon has no Google place", async () => {
    delete process.env.GOOGLE_MAPS_PLACE_ID;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const appointmentId = seedAppointment();

    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toMatchObject({
      reason: "REVIEW_LINK_NOT_CONFIGURED",
    });
    expect(buildPlatformReviewUrl("de")).toBeNull();
    expect(db.requests).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("marketing consent", () => {
  async function expectRefused(appointmentId: string): Promise<void> {
    const outcome = await service.scheduleForCompleted(appointmentId, { now: NOW });
    expect(outcome).toEqual({ status: "skipped", appointmentId, reason: "MARKETING_OPT_OUT" });
    expect(send).not.toHaveBeenCalled();
    expect(db.requests).toHaveLength(0);
    expect(db.logs).toHaveLength(0);
  }

  it("never asks a customer whose Customer flag says no", async () => {
    const customerId = seedCustomer({ marketingOptIn: false });
    seedConsent(customerId, "marketing", true, daysAgo(400));
    await expectRefused(seedAppointment({ customerId }));
  });

  it("never asks a customer whose newest marketing consent was withdrawn", async () => {
    const customerId = seedCustomer({ marketingOptIn: true });
    seedConsent(customerId, "marketing", true, daysAgo(400));
    seedConsent(customerId, "marketing", false, daysAgo(10));
    await expectRefused(seedAppointment({ customerId }));
  });

  it("never asks a customer who opted out of review requests specifically", async () => {
    const customerId = seedCustomer({ marketingOptIn: true });
    seedConsent(customerId, "marketing", true, daysAgo(400));
    seedConsent(customerId, "review", false, daysAgo(10));
    await expectRefused(seedAppointment({ customerId }));
  });

  it("still refuses when the withdrawal sits under a long history of newer consents", async () => {
    const customerId = seedCustomer({ marketingOptIn: true });
    seedConsent(customerId, "review", false, daysAgo(400));
    for (let index = 0; index < 25; index += 1) {
      seedConsent(customerId, "marketing", true, daysAgo(300 - index));
    }
    await expectRefused(seedAppointment({ customerId }));
  });

  it("prefers the withdrawal when a grant and a withdrawal share a millisecond", async () => {
    const customerId = seedCustomer({ marketingOptIn: true });
    const collision = daysAgo(30);
    seedConsent(customerId, "marketing", true, collision);
    seedConsent(customerId, "marketing", false, collision);
    await expectRefused(seedAppointment({ customerId }));
  });

  it("asks again once consent is granted back", async () => {
    const customerId = seedCustomer({ marketingOptIn: true });
    seedConsent(customerId, "marketing", false, daysAgo(400));
    seedConsent(customerId, "review", false, daysAgo(390));
    seedConsent(customerId, "marketing", true, daysAgo(10));
    seedConsent(customerId, "review", true, daysAgo(9));

    await expect(
      service.scheduleForCompleted(seedAppointment({ customerId }), { now: NOW }),
    ).resolves.toMatchObject({ status: "sent" });
  });

  it("treats a customer with no consent rows as governed by the flag alone", async () => {
    const customerId = seedCustomer({ marketingOptIn: true });
    await expect(
      service.scheduleForCompleted(seedAppointment({ customerId }), { now: NOW }),
    ).resolves.toMatchObject({ status: "sent" });
  });

  it("lets a recorded withdrawal beat a stale flag handed in by the caller", async () => {
    const customerId = seedCustomer({ marketingOptIn: true });
    const appointmentId = seedAppointment({ customerId });
    seedConsent(customerId, "marketing", false, daysAgo(1));

    const stale = {
      id: appointmentId,
      status: "completed" as const,
      endsAt: hoursAgo(4),
      locale: "de",
      customerId,
      customer: {
        id: customerId,
        firstName: "Anna",
        email: "anna@example.com",
        phone: null,
        locale: "de",
        marketingOptIn: true,
        deletedAt: null,
        anonymizedAt: null,
      },
    };

    await expect(service.scheduleForCompleted(stale, { now: NOW })).resolves.toEqual({
      status: "skipped",
      appointmentId,
      reason: "MARKETING_OPT_OUT",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps an opted-out customer out of the batch as well", async () => {
    const optedOut = seedCustomer({ id: "customer-out", marketingOptIn: true });
    seedConsent(optedOut, "marketing", false, daysAgo(5));
    seedAppointment({ id: "appointment-out", customerId: optedOut });
    const optedIn = seedCustomer({ id: "customer-in", email: "in@example.com" });
    seedAppointment({ id: "appointment-in", customerId: optedIn });

    const summary = await service.dispatchDue({ now: NOW });

    expect(summary.sent).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].recipient).toBe("in@example.com");
    expect(summary.results).toContainEqual({
      appointmentId: "appointment-out",
      status: "skipped",
      reason: "MARKETING_OPT_OUT",
    });
  });
});

describe("frequency capping across the whole relationship", () => {
  it("stops at the lifetime cap counted over every appointment the customer ever had", async () => {
    expect(DEFAULT_REVIEW_LIFETIME_CAP).toBe(3);
    const customerId = seedCustomer();
    for (let index = 0; index < DEFAULT_REVIEW_LIFETIME_CAP; index += 1) {
      const past = seedAppointment({ id: `past-${index}`, customerId, endsAt: daysAgo(900) });
      seedRequest({ appointmentId: past, sentAt: daysAgo(900 - index) });
    }
    const appointmentId = seedAppointment({ id: "fresh", customerId });

    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toEqual({
      status: "skipped",
      appointmentId,
      reason: "LIFETIME_CAP_REACHED",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("counts only this customer's own history", async () => {
    const stranger = seedCustomer({ id: "stranger" });
    for (let index = 0; index < 5; index += 1) {
      const past = seedAppointment({
        id: `stranger-${index}`,
        customerId: stranger,
        endsAt: daysAgo(900),
      });
      seedRequest({ appointmentId: past, sentAt: daysAgo(900 - index) });
    }
    const customerId = seedCustomer({ id: "regular" });
    const appointmentId = seedAppointment({ id: "fresh", customerId });

    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toMatchObject({
      status: "sent",
    });
  });

  it("keeps quiet inside the cooldown and speaks up once it has passed", async () => {
    expect(DEFAULT_REVIEW_COOLDOWN_DAYS).toBe(180);
    const customerId = seedCustomer();
    const past = seedAppointment({ id: "past", customerId, endsAt: daysAgo(179) });
    const recent = seedRequest({ appointmentId: past, sentAt: daysAgo(179) });
    const appointmentId = seedAppointment({ id: "fresh", customerId });

    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toEqual({
      status: "skipped",
      appointmentId,
      reason: "COOLDOWN_ACTIVE",
    });

    recent.sentAt = daysAgo(181);
    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toMatchObject({
      status: "sent",
    });
  });

  it("never asks again inside two years of someone actually clicking through", async () => {
    expect(DEFAULT_REVIEWED_COOLDOWN_DAYS).toBe(730);
    const customerId = seedCustomer();
    const past = seedAppointment({ id: "past", customerId, endsAt: daysAgo(729) });
    const clicked = seedRequest({
      appointmentId: past,
      sentAt: daysAgo(729),
      clickedAt: daysAgo(729),
    });
    const appointmentId = seedAppointment({ id: "fresh", customerId });

    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toEqual({
      status: "skipped",
      appointmentId,
      reason: "ALREADY_REVIEWED",
    });

    clicked.clickedAt = daysAgo(731);
    clicked.sentAt = daysAgo(731);
    await expect(service.scheduleForCompleted(appointmentId, { now: NOW })).resolves.toMatchObject({
      status: "sent",
    });
  });
});

describe("delivery failures", () => {
  it("leaves the request unsent and retries only after the cooldown", async () => {
    expect(REVIEW_RETRY_AFTER_MINUTES).toBe(60);
    send.mockResolvedValue({ status: "failed", provider: "gmail", reason: "SMTP_UNAVAILABLE" });
    const appointmentId = seedAppointment();

    const failed = await service.scheduleForCompleted(appointmentId, { now: NOW });
    expect(failed.status).toBe("failed");
    expect(requestFor(appointmentId).sentAt).toBeNull();
    expect(db.logs[0]).toMatchObject({
      status: "failed",
      sentAt: null,
      lastError: "FAILED:SMTP_UNAVAILABLE",
    });

    await expect(
      service.scheduleForCompleted(appointmentId, { now: new Date(NOW.getTime() + 59 * 60_000) }),
    ).resolves.toEqual({ status: "skipped", appointmentId, reason: "RETRY_TOO_SOON" });
    expect(send).toHaveBeenCalledTimes(1);

    send.mockResolvedValue({ status: "sent", provider: "gmail", messageId: "message-2" });
    const later = new Date(NOW.getTime() + 61 * 60_000);
    const retried = await service.scheduleForCompleted(appointmentId, { now: later });

    expect(retried.status).toBe("sent");
    if (retried.status === "skipped") throw new Error("expected a send");
    expect(retried.requestId).toBe(requestFor(appointmentId).id);
    expect(db.requests).toHaveLength(1);
    expect(requestFor(appointmentId).sentAt).toEqual(later);
  });

  it("turns a throwing transport into a failed outcome rather than an exception", async () => {
    send.mockRejectedValue(new Error("socket hang up"));
    const appointmentId = seedAppointment();

    const outcome = await service.scheduleForCompleted(appointmentId, { now: NOW });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "skipped") throw new Error("expected a delivery attempt");
    expect(outcome.delivery).toMatchObject({ reason: "DELIVERY_ERROR", detail: "socket hang up" });
    expect(db.logs[0]).toMatchObject({ status: "failed", lastError: expect.stringContaining("DELIVERY_ERROR") });
  });

  it("counts a simulated send as an ask so a dev run cannot loop", async () => {
    send.mockResolvedValue({ status: "simulated", provider: "gmail", reason: "GMAIL_NOT_CONFIGURED" });
    const appointmentId = seedAppointment();

    const outcome = await service.scheduleForCompleted(appointmentId, { now: NOW });
    expect(outcome.status).toBe("simulated");
    expect(requestFor(appointmentId).sentAt).toEqual(NOW);
    expect(db.logs[0]).toMatchObject({ status: "abandoned" });
  });
});

describe("review tokens", () => {
  it("round trips a request id", () => {
    const token = createReviewToken("request-42");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(verifyReviewToken(token)).toBe("request-42");
    expect(() => createReviewToken("")).toThrow("REVIEW_REQUEST_ID_REQUIRED");
  });

  it("rejects every way of tampering with the link", () => {
    const token = createReviewToken("request-42");
    const [payload, signature] = token.split(".") as [string, string];
    const other = createReviewToken("request-43");

    const forged = [
      "",
      ".",
      payload,
      `${payload}.`,
      `.${signature}`,
      `${payload}.${signature.slice(0, -1)}`,
      `${payload}.${signature}A`,
      `${payload}x.${signature}`,
      `${createReviewToken("request-43").split(".")[0]}.${signature}`,
      `${payload}.${other.split(".")[1]}`,
      token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(),
    ];
    for (const candidate of forged) {
      expect(verifyReviewToken(candidate)).toBeNull();
    }
    expect(verifyReviewToken(token)).toBe("request-42");
  });

  it("rejects a link signed with a different secret", () => {
    const token = createReviewToken("request-42");
    process.env.REVIEW_LINK_SECRET = "a-completely-different-secret-000";
    expect(verifyReviewToken(token)).toBeNull();
    process.env.REVIEW_LINK_SECRET = "review-link-secret-for-tests-0000";
    expect(verifyReviewToken(token)).toBe("request-42");
  });

  it("keeps the salon origin out of the token and in the url", () => {
    expect(buildReviewUrl("request-42")).toBe(
      `https://hairsimo.it/api/review/${createReviewToken("request-42")}`,
    );
  });
});

describe("click tracking", () => {
  it("records the first click and nothing after it", async () => {
    seedAppointment({ id: "appointment-1", locale: "it" });
    const request = seedRequest({ appointmentId: "appointment-1", sentAt: daysAgo(1) });
    const token = createReviewToken(request.id as string);
    const clickedAt = new Date(NOW.getTime() + 60_000);

    const first = await service.recordClick(token, { now: clickedAt });
    expect(first).toEqual({
      requestId: request.id,
      appointmentId: "appointment-1",
      redirectUrl: "https://search.google.com/local/writereview?placeid=ChIJhairsimo&hl=it",
      firstClick: true,
    });
    expect(request.clickedAt).toEqual(clickedAt);

    const second = await service.recordClick(token, { now: new Date(clickedAt.getTime() + 5_000) });
    expect(second.firstClick).toBe(false);
    expect(request.clickedAt).toEqual(clickedAt);
  });

  it("claims the click exactly once when the link is opened four times at once", async () => {
    seedAppointment({ id: "appointment-1" });
    const request = seedRequest({ appointmentId: "appointment-1", sentAt: daysAgo(1) });
    const token = createReviewToken(request.id as string);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => service.recordClick(token, { now: NOW })),
    );

    expect(results.filter((entry) => entry.firstClick)).toHaveLength(1);
    expect(request.clickedAt).toEqual(NOW);
    expect(db.prisma.reviewRequest.updateMany).toHaveBeenCalledTimes(4);
  });

  it("refuses a forged token and a token whose request is gone", async () => {
    await expect(service.recordClick("nonsense", { now: NOW })).rejects.toThrow(
      "INVALID_REVIEW_TOKEN",
    );
    await expect(
      service.recordClick(createReviewToken("request-gone"), { now: NOW }),
    ).rejects.toThrow("REVIEW_REQUEST_NOT_FOUND");
  });

  it("falls back to the salon site when Google is not configured", async () => {
    delete process.env.GOOGLE_MAPS_PLACE_ID;
    seedAppointment({ id: "appointment-1", locale: "fr" });
    const request = seedRequest({ appointmentId: "appointment-1", sentAt: daysAgo(1) });

    await expect(
      service.recordClick(createReviewToken(request.id as string), { now: NOW }),
    ).resolves.toMatchObject({ redirectUrl: "https://hairsimo.it/fr" });
  });
});

describe("metrics", () => {
  it("matches the fixtures and ignores rows outside the window", async () => {
    const from = daysAgo(30);
    const to = NOW;

    seedRequest({
      id: "clicked-fast",
      createdAt: daysAgo(20),
      sentAt: daysAgo(20),
      clickedAt: new Date(daysAgo(20).getTime() + 2 * MS_PER_HOUR),
    });
    seedRequest({
      id: "clicked-slow",
      createdAt: daysAgo(10),
      sentAt: daysAgo(10),
      clickedAt: new Date(daysAgo(10).getTime() + 5 * MS_PER_HOUR),
    });
    seedRequest({ id: "sent-only", createdAt: daysAgo(5), sentAt: daysAgo(5) });
    seedRequest({ id: "never-left", createdAt: daysAgo(2) });
    seedRequest({ id: "before-window", createdAt: daysAgo(40), sentAt: daysAgo(40) });
    seedRequest({ id: "after-window", createdAt: new Date(NOW.getTime() + 60_000) });

    const metrics = await service.getMetrics({ from, to });

    expect(metrics.created).toBe(4);
    expect(metrics.sent).toBe(3);
    expect(metrics.clicked).toBe(2);
    expect(metrics.pending).toBe(1);
    expect(metrics.clickRate).toBe(0.6667);
    expect(metrics.averageHoursToClick).toBe(3.5);
  });

  it("reports a zero rate rather than dividing by nothing", async () => {
    seedRequest({ id: "never-left", createdAt: daysAgo(2) });
    const metrics = await service.getMetrics({ from: daysAgo(30), to: NOW });
    expect(metrics).toMatchObject({ created: 1, sent: 0, clicked: 0, clickRate: 0 });
    expect(metrics.averageHoursToClick).toBeNull();
  });

  it("labels the window in the salon zone and not the host zone", async () => {
    const lateEvening = new Date("2026-05-01T22:30:00.000Z");
    const midday = new Date("2026-05-01T12:00:00.000Z");

    const rolled = await service.getMetrics({ from: lateEvening, to: midday, locale: "en" });
    expect(rolled.fromLabel).toContain("2 May");
    expect(rolled.toLabel).toContain("1 May");

    const german = await service.getMetrics({ from: lateEvening, to: midday, locale: "de" });
    expect(german.fromLabel).not.toBe(rolled.fromLabel);
    expect(german.fromLabel).toContain("2");
  });
});

describe("batch dispatch", () => {
  it("works through the due appointments oldest first and reports what happened", async () => {
    const regular = seedCustomer({ id: "regular", email: "regular@example.com" });
    seedAppointment({ id: "oldest", customerId: regular, endsAt: daysAgo(13) });
    const second = seedCustomer({ id: "second", email: "second@example.com" });
    seedAppointment({ id: "newest", customerId: second, endsAt: hoursAgo(4) });
    seedAppointment({
      id: "still-warm",
      customerId: seedCustomer({ id: "third", email: "third@example.com" }),
      endsAt: hoursAgo(1),
    });
    seedAppointment({
      id: "stale",
      customerId: seedCustomer({ id: "fourth", email: "fourth@example.com" }),
      endsAt: daysAgo(20),
    });
    seedAppointment({
      id: "cancelled",
      customerId: seedCustomer({ id: "fifth", email: "fifth@example.com" }),
      status: "cancelled",
    });

    const summary = await service.dispatchDue({ now: NOW });

    expect(summary.processed).toBe(2);
    expect(summary.sent).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.results.map((entry) => entry.appointmentId)).toEqual(["oldest", "newest"]);
    expect(db.requests.map((row) => row.appointmentId).sort()).toEqual(["newest", "oldest"]);
  });

  it("does not pick up an appointment that was already asked about", async () => {
    const customerId = seedCustomer();
    const appointmentId = seedAppointment({ customerId });
    seedRequest({ appointmentId, sentAt: daysAgo(1) });

    const summary = await service.dispatchDue({ now: NOW });
    expect(summary.processed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once when two cron runs overlap on the same appointment", async () => {
    seedAppointment({ id: "appointment-1" });

    const [first, second] = await Promise.all([
      service.dispatchDue({ now: NOW }),
      service.dispatchDue({ now: NOW }),
    ]);

    expect(first.sent + second.sent).toBe(1);
    expect(first.skipped + second.skipped).toBe(1);
    expect(db.requests).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect([...first.results, ...second.results]).toContainEqual({
      appointmentId: "appointment-1",
      status: "skipped",
      reason: "ALREADY_REQUESTED",
    });
  });

  it("asks a customer with two due visits about only one of them", async () => {
    const customerId = seedCustomer();
    seedAppointment({ id: "first-visit", customerId, endsAt: daysAgo(10) });
    seedAppointment({ id: "second-visit", customerId, endsAt: hoursAgo(4) });

    const summary = await service.dispatchDue({ now: NOW });

    expect(summary.processed).toBe(2);
    expect(summary.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(summary.results).toContainEqual({
      appointmentId: "second-visit",
      status: "skipped",
      reason: "COOLDOWN_ACTIVE",
    });
  });

  it("clamps the batch size to something a cron run can finish", async () => {
    for (let index = 0; index < 5; index += 1) {
      seedAppointment({
        id: `appointment-${index}`,
        customerId: seedCustomer({ id: `customer-${index}`, email: `c${index}@example.com` }),
        endsAt: daysAgo(index + 1),
      });
    }

    const summary = await service.dispatchDue({ now: NOW, limit: 2 });
    expect(summary.processed).toBe(2);

    const unbounded = await service.dispatchDue({ now: NOW, limit: -5 });
    expect(unbounded.processed).toBe(1);
  });
});
