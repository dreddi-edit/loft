import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

/**
 * An in-memory stand-in for the Prisma client covering every table the GDPR service
 * touches. It enforces the unique constraints that matter here (Customer.email,
 * Customer.phone) and gives `$transaction` real snapshot/rollback semantics plus
 * serialisation, so atomicity and concurrency can be asserted rather than assumed.
 */
const { db } = vi.hoisted(() => {
  const MODELS = [
    "customer",
    "customerNote",
    "appointment",
    "appointmentStatusHistory",
    "payment",
    "refund",
    "conversation",
    "message",
    "callLog",
    "notificationLog",
    "consentRecord",
    "waitlist",
    "recurringSeries",
    "voucher",
    "voucherRedemption",
    "reviewRequest",
    "bookingVerification",
    "dataRequest",
    "auditLog",
    "service",
    "serviceTranslation",
    "staffProfile",
  ];

  const UNIQUE: Record<string, string[]> = {
    customer: ["email", "phone"],
    service: ["slug"],
    voucher: ["code"],
    payment: ["idempotencyKey"],
    bookingVerification: ["appointmentId", "tokenHash"],
    reviewRequest: ["appointmentId"],
  };

  // Anchored to the suite's NOW. A 1970 epoch here would make every timestamp the
  // service writes land before the fixture, which hides ordering and idempotence bugs.
  const NOW_MS = Date.parse("2026-07-29T09:00:00.000Z");
  let sequence = 0;
  let generated = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const failNextKeys = new Set<string>();

  const tables: Record<string, Row[]> = {};
  for (const model of MODELS) tables[model] = [];

  function tick(): Date {
    sequence += 1;
    return new Date(NOW_MS + sequence);
  }

  function clone(value: unknown): unknown {
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Row).map(([key, item]) => [key, clone(item)]));
    }
    return value;
  }

  function cloneRow(row: Row): Row {
    return clone(row) as Row;
  }

  function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
  }

  function matchField(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return comparable(actual) === expected.getTime();
    if (typeof expected === "object") {
      const condition = expected as Row;
      const insensitive = condition.mode === "insensitive";
      return Object.entries(condition).every(([operator, operand]) => {
        if (operator === "mode") return true;
        if (operator === "equals") return matchField(actual, operand);
        if (operator === "in") return (operand as unknown[]).some((value) => matchField(actual, value));
        if (operator === "notIn") return !(operand as unknown[]).some((value) => matchField(actual, value));
        if (operator === "not") return !matchField(actual, operand);
        if (operator === "contains" || operator === "startsWith" || operator === "endsWith") {
          if (typeof actual !== "string") return false;
          const haystack = insensitive ? actual.toLowerCase() : actual;
          const needle = insensitive ? String(operand).toLowerCase() : String(operand);
          if (operator === "contains") return haystack.includes(needle);
          if (operator === "startsWith") return haystack.startsWith(needle);
          return haystack.endsWith(needle);
        }
        const left = comparable(actual) as number;
        const right = comparable(operand) as number;
        if (operator === "lt") return left < right;
        if (operator === "lte") return left <= right;
        if (operator === "gt") return left > right;
        if (operator === "gte") return left >= right;
        throw new Error(`unsupported operator ${operator}`);
      });
    }
    return actual === expected;
  }

  function matchRow(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return (condition as Row[]).some((clause) => matchRow(row, clause));
      if (key === "AND") return (condition as Row[]).every((clause) => matchRow(row, clause));
      if (key === "NOT") return !matchRow(row, condition as Row);
      return matchField(row[key], condition);
    });
  }

  function sortRows(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return [...rows].sort((left, right) => {
      for (const clause of clauses) {
        const [key, direction] = Object.entries(clause)[0] as [string, string];
        const a = comparable(left[key]);
        const b = comparable(right[key]);
        if (a === b) continue;
        if (a === null || a === undefined) return direction === "desc" ? 1 : -1;
        if (b === null || b === undefined) return direction === "desc" ? -1 : 1;
        const result = (a as number) < (b as number) ? -1 : 1;
        return direction === "desc" ? -result : result;
      }
      return 0;
    });
  }

  function project(row: Row, select: Row | undefined): Row {
    if (!select) return cloneRow(row);
    const out: Row = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (wanted) out[key] = clone(row[key] ?? null);
    }
    return out;
  }

  function uniqueViolation(model: string, field: string): Error {
    return Object.assign(new Error(`Unique constraint failed on ${model}.${field}`), {
      code: "P2002",
      meta: { target: [field] },
    });
  }

  function assertUnique(model: string, candidate: Row, ignoreId?: string): void {
    for (const field of UNIQUE[model] ?? []) {
      const value = candidate[field];
      if (value === null || value === undefined) continue;
      const clash = (tables[model] as Row[]).some(
        (row) => row.id !== ignoreId && row[field] === value,
      );
      if (clash) throw uniqueViolation(model, field);
    }
  }

  function guard(key: string): void {
    if (!failNextKeys.has(key)) return;
    failNextKeys.delete(key);
    throw new Error(`INJECTED_FAILURE:${key}`);
  }

  function delegate(model: string) {
    const rows = () => tables[model] as Row[];
    return {
      findMany: vi.fn(async (args: Args = {}) => {
        let found = rows().filter((row) => matchRow(row, args.where as Row | undefined));
        found = sortRows(found, args.orderBy);
        if (typeof args.take === "number") found = found.slice(0, args.take);
        return found.map((row) => project(row, args.select as Row | undefined));
      }),
      findFirst: vi.fn(async (args: Args = {}) => {
        const found = sortRows(
          rows().filter((row) => matchRow(row, args.where as Row | undefined)),
          args.orderBy,
        )[0];
        return found ? project(found, args.select as Row | undefined) : null;
      }),
      findUnique: vi.fn(async (args: Args) => {
        const found = rows().find((row) => matchRow(row, args.where as Row));
        return found ? project(found, args.select as Row | undefined) : null;
      }),
      count: vi.fn(
        async (args: Args = {}) =>
          rows().filter((row) => matchRow(row, args.where as Row | undefined)).length,
      ),
      create: vi.fn(async (args: Args) => {
        guard(`${model}.create`);
        generated += 1;
        const at = tick();
        const row: Row = {
          id: `${model}-generated-${generated}`,
          createdAt: at,
          updatedAt: at,
          ...(clone(args.data) as Row),
        };
        assertUnique(model, row);
        rows().push(row);
        return project(row, args.select as Row | undefined);
      }),
      update: vi.fn(async (args: Args) => {
        guard(`${model}.update`);
        const found = rows().find((row) => matchRow(row, args.where as Row));
        if (!found) {
          throw Object.assign(new Error(`No ${model} found`), { code: "P2025" });
        }
        const patch = clone(args.data) as Row;
        assertUnique(model, { ...found, ...patch }, found.id as string);
        Object.assign(found, patch, { updatedAt: tick() });
        return project(found, args.select as Row | undefined);
      }),
      updateMany: vi.fn(async (args: Args) => {
        guard(`${model}.updateMany`);
        const targets = rows().filter((row) => matchRow(row, args.where as Row | undefined));
        for (const row of targets) {
          Object.assign(row, clone(args.data) as Row, { updatedAt: tick() });
        }
        return { count: targets.length };
      }),
      deleteMany: vi.fn(async (args: Args = {}) => {
        guard(`${model}.deleteMany`);
        const keep = rows().filter((row) => !matchRow(row, args.where as Row | undefined));
        const removed = rows().length - keep.length;
        rows().length = 0;
        rows().push(...keep);
        return { count: removed };
      }),
    };
  }

  const delegates: Record<string, ReturnType<typeof delegate>> = {};
  for (const model of MODELS) delegates[model] = delegate(model);

  function snapshot(): Record<string, Row[]> {
    return Object.fromEntries(MODELS.map((model) => [model, (tables[model] as Row[]).map(cloneRow)]));
  }

  function restore(saved: Record<string, Row[]>): void {
    for (const model of MODELS) {
      const rows = tables[model] as Row[];
      rows.length = 0;
      rows.push(...(saved[model] as Row[]));
    }
  }

  // Serialising the callbacks reproduces what Read Committed looks like from the
  // caller's side: the second transaction only starts once the first has committed.
  const $transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
    const settled = queue.then(async () => {
      const saved = snapshot();
      try {
        return await run(delegates);
      } catch (error) {
        restore(saved);
        throw error;
      }
    });
    queue = settled.catch(() => undefined);
    return settled;
  });

  return {
    db: {
      models: MODELS,
      tables,
      prisma: { ...delegates, $transaction },
      $transaction,
      client(model: string): ReturnType<typeof delegate> {
        return delegates[model] as ReturnType<typeof delegate>;
      },
      rows(model: string): Row[] {
        return tables[model] as Row[];
      },
      find(model: string, id: string): Row {
        const row = (tables[model] as Row[]).find((entry) => entry.id === id);
        if (!row) throw new Error(`${model} ${id} not found`);
        return row;
      },
      failNext(key: string): void {
        failNextKeys.add(key);
      },
      reset(): void {
        for (const model of MODELS) (tables[model] as Row[]).length = 0;
        sequence = 0;
        generated = 0;
        queue = Promise.resolve();
        failNextKeys.clear();
      },
    },
  };
});

vi.mock("@hair-simo/db", () => ({ prisma: db.prisma }));

import {
  CUSTOMER_EXPORT_SCHEMA_VERSION,
  ERASURE_RECEIPT_SCHEMA_VERSION,
  ERASURE_REDACTION_MARKER,
  ERASURE_SUBJECT_ACTOR,
  GdprError,
  GdprService,
  LIVE_CUSTOMER_WHERE,
  MARKETING_CONSENT_TYPE,
} from "./gdpr-service";

const NOW = new Date("2026-07-29T09:00:00.000Z");
const service = new GdprService();

const SUBJECT = "cus-subject";
const OTHER = "cus-third";
const SUBJECT_EMAIL = "anna.rossi@example.it";
const SUBJECT_PHONE = "+390472268402";
const SUBJECT_FIRST = "Anna";
const SUBJECT_LAST = "Rossi";
const OTHER_EMAIL = "luca.bianchi@example.it";
const OTHER_PHONE = "+393331234567";

const SUBJECT_IDENTIFIERS = {
  email: SUBJECT_EMAIL,
  phone: SUBJECT_PHONE,
  firstName: SUBJECT_FIRST,
  lastName: SUBJECT_LAST,
};

/**
 * Every relation the Prisma schema attaches to Customer, directly or through a row the
 * customer owns. Read off packages/db/prisma/schema.prisma: a new relation added there
 * without a matching export bucket makes this list, and the assertions below, fail.
 */
const CUSTOMER_REACHABLE_RELATIONS = [
  "appointmentStatusHistory",
  "appointments",
  "auditTrail",
  "bookingVerifications",
  "callLogs",
  "consentRecords",
  "conversations",
  "customerNotes",
  "dataRequests",
  "messages",
  "notifications",
  "payments",
  "recurringSeries",
  "refunds",
  "reviewRequests",
  "vouchers",
  "voucherRedemptions",
  "waitlistEntries",
];

const DEFAULTS: Record<string, Row> = {
  customer: {
    email: null,
    phone: null,
    locale: "de",
    sourceChannel: "web",
    marketingOptIn: false,
    deletedAt: null,
    anonymizedAt: null,
  },
  customerNote: { kind: "general", authorId: null, pinned: false },
  appointment: {
    staffId: null,
    seriesId: null,
    locale: "de",
    status: "completed",
    sourceChannel: "web",
    notes: null,
    cancellationReason: null,
    depositRequired: true,
    noShowFeeCents: 0,
    googleEventId: null,
  },
  appointmentStatusHistory: { changedBy: null, reason: null },
  payment: {
    provider: "stripe",
    providerIntentId: null,
    idempotencyKey: null,
    tipCents: 0,
    refundedCents: 0,
    currency: "EUR",
    mode: "deposit",
    status: "paid",
  },
  refund: { reason: null, providerRefId: null },
  conversation: { customerId: null, locale: "de", externalRef: null },
  message: { metadata: null },
  callLog: { customerId: null, locale: "de", fromNumber: null, toNumber: null, fallback: false },
  notificationLog: {
    appointmentId: null,
    channel: "sms",
    status: "sent",
    attempts: 1,
    lastError: null,
    sentAt: null,
  },
  consentRecord: { metadata: null },
  waitlist: {
    staffId: null,
    locale: "de",
    channel: "web",
    status: "active",
    notifiedAt: null,
    convertedAppointmentId: null,
  },
  recurringSeries: { staffId: null, endsAt: null, active: true, locale: "de", channel: "web" },
  voucher: {
    currency: "EUR",
    expiresAt: null,
    active: true,
    issuedToCustomerId: null,
    note: null,
  },
  voucherRedemption: { appointmentId: null, paymentId: null },
  reviewRequest: { sentAt: null, clickedAt: null, platform: "google" },
  bookingVerification: { verifiedAt: null, sentCount: 1 },
  dataRequest: {
    status: "pending",
    requestedBy: null,
    completedAt: null,
    resultLocation: null,
    error: null,
  },
  auditLog: { actorId: null, before: null, after: null, ip: null, userAgent: null },
  service: { bufferAfterMin: 10, currency: "EUR", isActive: true },
  serviceTranslation: {},
  staffProfile: { bio: null, phone: null, locale: "de", isBookable: true, googleCalendarId: null },
};

let seedClock = Date.parse("2024-01-01T08:00:00.000Z");

function insert(model: string, row: Row): void {
  seedClock += 60_000;
  const at = new Date(seedClock);
  db.rows(model).push({ createdAt: at, updatedAt: at, ...DEFAULTS[model], ...row });
}

function seedWorld(): void {
  seedClock = Date.parse("2024-01-01T08:00:00.000Z");

  insert("staffProfile", {
    id: "staff-1",
    userId: "user-simona",
    displayName: "Simona",
    bio: "Colour specialist, private staff biography",
    phone: "+390472999888",
    googleCalendarId: "simona@group.calendar.google.com",
  });
  insert("service", {
    id: "svc-cut",
    slug: "haircut-women",
    category: "hair",
    durationMin: 45,
    priceCents: 4500,
  });
  insert("serviceTranslation", {
    id: "svc-cut-it",
    serviceId: "svc-cut",
    locale: "it",
    name: "Taglio donna",
    description: "Taglio e piega",
  });
  insert("serviceTranslation", {
    id: "svc-cut-de",
    serviceId: "svc-cut",
    locale: "de",
    name: "Damenhaarschnitt",
    description: "Schnitt und Föhnen",
  });

  insert("customer", {
    id: SUBJECT,
    email: SUBJECT_EMAIL,
    phone: SUBJECT_PHONE,
    firstName: SUBJECT_FIRST,
    lastName: SUBJECT_LAST,
    locale: "it",
    sourceChannel: "whatsapp",
    marketingOptIn: true,
  });
  insert("customer", {
    id: OTHER,
    email: OTHER_EMAIL,
    phone: OTHER_PHONE,
    firstName: "Luca",
    lastName: "Bianchi",
    locale: "de",
  });

  insert("customerNote", {
    id: "note-subject-1",
    customerId: SUBJECT,
    note: `${SUBJECT_FIRST} ${SUBJECT_LAST} is allergic to ammonia, reach her on ${SUBJECT_PHONE}`,
    kind: "allergy",
    pinned: true,
  });
  insert("customerNote", {
    id: "note-third-1",
    customerId: OTHER,
    note: "Luca Bianchi prefers the 18:00 slot",
  });

  insert("appointment", {
    id: "apt-subject-1",
    customerId: SUBJECT,
    serviceId: "svc-cut",
    staffId: "staff-1",
    seriesId: "series-subject-1",
    startsAt: new Date("2026-03-04T09:00:00.000Z"),
    endsAt: new Date("2026-03-04T09:45:00.000Z"),
    locale: "it",
    notes: `${SUBJECT_FIRST} ${SUBJECT_LAST} wants the same colour as last time`,
    cancellationReason: null,
    googleEventId: "gcal-event-1",
  });
  insert("appointment", {
    id: "apt-subject-2",
    customerId: SUBJECT,
    serviceId: "svc-cut",
    staffId: "staff-1",
    startsAt: new Date("2026-06-10T09:00:00.000Z"),
    endsAt: new Date("2026-06-10T09:45:00.000Z"),
    locale: "it",
    status: "cancelled",
    cancellationReason: `${SUBJECT_FIRST} ${SUBJECT_LAST} called to cancel`,
  });
  insert("appointment", {
    id: "apt-third-1",
    customerId: OTHER,
    serviceId: "svc-cut",
    staffId: "staff-1",
    startsAt: new Date("2026-06-11T09:00:00.000Z"),
    endsAt: new Date("2026-06-11T09:45:00.000Z"),
    notes: "Luca wants a fade",
  });

  insert("appointmentStatusHistory", {
    id: "hist-subject-1",
    appointmentId: "apt-subject-1",
    status: "completed",
    changedBy: "user-simona",
    reason: `confirmed by ${SUBJECT_EMAIL}`,
  });
  insert("appointmentStatusHistory", {
    id: "hist-third-1",
    appointmentId: "apt-third-1",
    status: "confirmed",
    reason: "confirmed by luca.bianchi@example.it",
  });

  insert("payment", {
    id: "pay-subject-1",
    appointmentId: "apt-subject-1",
    amountCents: 4500,
    tipCents: 500,
    refundedCents: 1000,
    providerIntentId: "pi_1",
    idempotencyKey: "idem-subject-1",
  });
  insert("payment", {
    id: "pay-third-1",
    appointmentId: "apt-third-1",
    amountCents: 3000,
    idempotencyKey: "idem-third-1",
  });
  insert("refund", {
    id: "ref-subject-1",
    paymentId: "pay-subject-1",
    amountCents: 1000,
    reason: `goodwill refund agreed with ${SUBJECT_EMAIL}`,
    providerRefId: "re_1",
  });
  insert("refund", {
    id: "ref-third-1",
    paymentId: "pay-third-1",
    amountCents: 500,
    reason: "duplicate charge",
  });

  insert("conversation", {
    id: "conv-subject",
    customerId: SUBJECT,
    channel: "whatsapp",
    locale: "it",
    externalRef: `whatsapp:${SUBJECT_PHONE}`,
  });
  insert("conversation", {
    id: "conv-orphan",
    customerId: null,
    channel: "web",
    externalRef: "web:anonymous-session-7",
  });
  insert("message", {
    id: "msg-subject-1",
    conversationId: "conv-subject",
    role: "user",
    content: `Ciao, sono ${SUBJECT_FIRST} ${SUBJECT_LAST}, vorrei prenotare`,
    metadata: { from: SUBJECT_PHONE },
  });
  insert("message", {
    id: "msg-orphan-1",
    conversationId: "conv-orphan",
    role: "user",
    content: "Do you take walk-ins on Saturday?",
  });

  insert("callLog", {
    id: "call-subject-linked",
    customerId: SUBJECT,
    locale: "it",
    fromNumber: SUBJECT_PHONE,
    toNumber: "+390472000000",
    summary: `${SUBJECT_FIRST} ${SUBJECT_LAST} asked to move her appointment`,
    actionTaken: "rescheduled",
  });
  insert("callLog", {
    id: "call-subject-unlinked",
    customerId: null,
    fromNumber: SUBJECT_PHONE,
    toNumber: "+390472000000",
    summary: `caller reachable on ${SUBJECT_PHONE}`,
    actionTaken: "left_message",
  });
  insert("callLog", {
    id: "call-third",
    customerId: OTHER,
    fromNumber: OTHER_PHONE,
    toNumber: "+390472000000",
    summary: "Luca asked about opening hours",
    actionTaken: "answered",
  });

  insert("notificationLog", {
    id: "notif-subject-apt",
    appointmentId: "apt-subject-1",
    channel: "sms",
    recipient: SUBJECT_PHONE,
    templateKey: "appointment.reminder",
    payload: { name: `${SUBJECT_FIRST} ${SUBJECT_LAST}`, phone: SUBJECT_PHONE },
    sentAt: new Date("2026-03-03T09:00:00.000Z"),
  });
  insert("notificationLog", {
    id: "notif-subject-standalone",
    appointmentId: null,
    channel: "sms",
    recipient: SUBJECT_EMAIL,
    templateKey: "marketing.newsletter",
    payload: { name: SUBJECT_FIRST },
  });
  insert("notificationLog", {
    id: "notif-subject-on-other-appointment",
    appointmentId: "apt-third-1",
    channel: "sms",
    recipient: SUBJECT_EMAIL,
    templateKey: "appointment.booked_for_friend",
    payload: { bookedBy: SUBJECT_EMAIL },
  });
  insert("notificationLog", {
    id: "notif-third",
    appointmentId: "apt-third-1",
    channel: "sms",
    recipient: OTHER_PHONE,
    templateKey: "appointment.reminder",
    payload: { name: "Luca Bianchi" },
  });

  insert("consentRecord", {
    id: "consent-subject-1",
    customerId: SUBJECT,
    type: MARKETING_CONSENT_TYPE,
    granted: true,
    source: "web-checkout",
    metadata: { ip: "10.0.0.4", email: SUBJECT_EMAIL },
  });
  insert("consentRecord", {
    id: "consent-third-1",
    customerId: OTHER,
    type: MARKETING_CONSENT_TYPE,
    granted: true,
    source: "web-checkout",
  });

  insert("waitlist", {
    id: "wait-subject-1",
    customerId: SUBJECT,
    serviceId: "svc-cut",
    staffId: "staff-1",
    earliestAt: new Date("2026-08-01T07:00:00.000Z"),
    latestAt: new Date("2026-08-08T17:00:00.000Z"),
    locale: "it",
    status: "active",
  });
  insert("waitlist", {
    id: "wait-third-1",
    customerId: OTHER,
    serviceId: "svc-cut",
    earliestAt: new Date("2026-08-01T07:00:00.000Z"),
    latestAt: new Date("2026-08-08T17:00:00.000Z"),
  });

  insert("recurringSeries", {
    id: "series-subject-1",
    customerId: SUBJECT,
    serviceId: "svc-cut",
    staffId: "staff-1",
    intervalWeeks: 6,
    nextAt: new Date("2026-08-20T09:00:00.000Z"),
    locale: "it",
  });

  insert("voucher", {
    id: "vou-subject-1",
    code: "GIFT-2026-0001",
    initialCents: 10_000,
    remainingCents: 4_000,
    issuedToCustomerId: SUBJECT,
    note: `bought by ${SUBJECT_FIRST} ${SUBJECT_LAST}`,
  });
  insert("voucherRedemption", {
    id: "red-subject-own",
    voucherId: "vou-subject-1",
    appointmentId: "apt-subject-1",
    paymentId: "pay-subject-1",
    amountCents: 3_000,
  });
  insert("voucherRedemption", {
    id: "red-subject-gift",
    voucherId: "vou-subject-1",
    appointmentId: "apt-third-1",
    paymentId: "pay-third-1",
    amountCents: 3_000,
  });

  insert("reviewRequest", { id: "rev-subject-1", appointmentId: "apt-subject-1" });
  insert("reviewRequest", { id: "rev-third-1", appointmentId: "apt-third-1" });

  insert("bookingVerification", {
    id: "ver-subject-1",
    appointmentId: "apt-subject-1",
    tokenHash: "b8f1c0a9deadbeefcafefeed00000000deadbeefcafefeed0000000011112222",
    expiresAt: new Date("2026-03-03T09:00:00.000Z"),
    verifiedAt: new Date("2026-03-02T09:00:00.000Z"),
  });
  insert("bookingVerification", {
    id: "ver-third-1",
    appointmentId: "apt-third-1",
    tokenHash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    expiresAt: new Date("2026-06-10T09:00:00.000Z"),
  });

  insert("dataRequest", {
    id: "req-subject-1",
    customerId: SUBJECT,
    type: "erasure",
    status: "pending",
    requestedBy: SUBJECT_EMAIL,
  });
  insert("dataRequest", { id: "req-third-1", customerId: OTHER, type: "export" });

  insert("auditLog", {
    id: "audit-subject-update",
    actorEmail: "simona@hairsimo.it",
    actorRole: "owner",
    action: "customer.update",
    entityType: "customer",
    entityId: SUBJECT,
    before: { firstName: SUBJECT_FIRST, email: SUBJECT_EMAIL },
    after: { firstName: SUBJECT_FIRST, email: SUBJECT_EMAIL, phone: SUBJECT_PHONE },
    ip: "10.0.0.9",
    userAgent: "Mozilla/5.0 (staff laptop)",
  });
  insert("auditLog", {
    id: "audit-subject-appointment",
    actorEmail: "simona@hairsimo.it",
    actorRole: "staff",
    action: "appointment.reschedule",
    entityType: "appointment",
    entityId: "apt-subject-1",
    before: { notes: `${SUBJECT_FIRST} wants the same colour` },
    after: { notes: "moved" },
  });
  insert("auditLog", {
    id: "audit-subject-self-service",
    actorEmail: SUBJECT_EMAIL,
    actorRole: "customer",
    action: "customer.portal.login",
    entityType: "customer",
    entityId: SUBJECT,
  });
  insert("auditLog", {
    id: "audit-third",
    actorEmail: "simona@hairsimo.it",
    actorRole: "owner",
    action: "customer.update",
    entityType: "customer",
    entityId: OTHER,
    before: { email: OTHER_EMAIL },
  });
}

/**
 * An audit of erasure that shares no code with the service. It walks every column of
 * every table, including JSON, so a hole in the service's own residue scanner cannot
 * hide a hole in the erasure.
 */
function independentScan(needles: string[]): string[] {
  const hits: string[] = [];
  for (const model of db.models) {
    for (const row of db.rows(model)) {
      for (const [field, value] of Object.entries(row)) {
        if (value === null || value === undefined || value instanceof Date) continue;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        for (const needle of needles) {
          if (text.toLowerCase().includes(needle.toLowerCase())) {
            hits.push(`${model}.${field} on ${String(row.id)} still holds "${needle}"`);
          }
        }
      }
    }
  }
  return hits;
}

const SUBJECT_NEEDLES = [SUBJECT_EMAIL, SUBJECT_PHONE, SUBJECT_FIRST, SUBJECT_LAST];

function subjectRow(): Row {
  return db.find("customer", SUBJECT);
}

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  seedWorld();
});

describe("export completeness (Art. 15)", () => {
  it("covers every relation the schema attaches to a customer", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(Object.keys(document.counts).sort()).toEqual([...CUSTOMER_REACHABLE_RELATIONS].sort());
    for (const relation of CUSTOMER_REACHABLE_RELATIONS) {
      expect(`${relation}=${document.counts[relation]}`).not.toBe(`${relation}=0`);
    }
  });

  it("reports counts that agree with the payload it shipped", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(document.counts).toMatchObject({
      customerNotes: 1,
      appointments: 2,
      appointmentStatusHistory: 1,
      payments: 1,
      refunds: 1,
      conversations: 1,
      messages: 1,
      callLogs: 1,
      notifications: 3,
      consentRecords: 1,
      waitlistEntries: 1,
      recurringSeries: 1,
      vouchers: 1,
      voucherRedemptions: 2,
      reviewRequests: 1,
      bookingVerifications: 1,
      dataRequests: 1,
      auditTrail: 3,
    });
    expect(document.customerNotes).toHaveLength(document.counts.customerNotes as number);
    expect(document.payments[0]?.refunds).toHaveLength(document.counts.refunds as number);
    expect(document.conversations[0]?.messages).toHaveLength(document.counts.messages as number);
  });

  it("includes messages the salon sent to the subject that hang off no appointment", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });
    const exported = document.notifications.map((row) => row.id);

    expect(exported).toContain("notif-subject-apt");
    expect(exported).toContain("notif-subject-standalone");
    expect(exported).not.toContain("notif-third");
  });

  it("resolves the service name in the subject's own locale", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(document.locale).toBe("it");
    expect(document.appointments[0]?.service?.name).toBe("Taglio donna");
    expect(document.appointments[0]?.staffDisplayName).toBe("Simona");
  });

  it("falls back to a supported locale for an unsupported customer language", async () => {
    (subjectRow() as Row).locale = "es";
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(document.locale).toBe("de");
    expect(document.appointments[0]?.service?.name).toBe("Damenhaarschnitt");
  });

  it("rejects an unknown subject", async () => {
    await expect(service.exportCustomerData("nobody", { now: NOW })).rejects.toBeInstanceOf(
      GdprError,
    );
    await expect(service.exportCustomerData("nobody", { now: NOW })).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );
  });

  it("still answers for a soft-deleted subject", async () => {
    (subjectRow() as Row).deletedAt = new Date("2026-07-01T00:00:00.000Z");
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(document.subjectId).toBe(SUBJECT);
    expect(document.customer.deletedAt).not.toBeNull();
  });
});

describe("export isolation", () => {
  it("leaks nothing about the other customer reachable through shared rows", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });
    const serialised = JSON.stringify(document).toLowerCase();

    for (const forbidden of [
      OTHER_EMAIL,
      OTHER_PHONE,
      "luca",
      "bianchi",
      "apt-third-1",
      "pay-third-1",
      "ref-third-1",
      "notif-third",
      "conv-orphan",
      "msg-orphan-1",
      "call-third",
      "wait-third-1",
      "rev-third-1",
      "ver-third-1",
      "req-third-1",
      "audit-third",
      "hist-third-1",
      "consent-third-1",
      "note-third-1",
    ]) {
      expect(serialised).not.toContain(forbidden.toLowerCase());
    }
  });

  it("withholds the third-party appointment a gifted voucher was redeemed on", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });
    const redemptions = document.vouchers[0]?.redemptions ?? [];

    expect(redemptions).toHaveLength(2);
    expect(redemptions.find((row) => row.id === "red-subject-own")).toMatchObject({
      appointmentId: "apt-subject-1",
      appointmentBelongsToSubject: true,
      amountCents: 3_000,
    });
    expect(redemptions.find((row) => row.id === "red-subject-gift")).toMatchObject({
      appointmentId: null,
      appointmentBelongsToSubject: false,
      amountCents: 3_000,
    });
  });

  it("withholds a third-party appointment id from a notification addressed to the subject", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });
    const shared = document.notifications.find(
      (row) => row.id === "notif-subject-on-other-appointment",
    );

    expect(shared).toBeDefined();
    expect(shared?.recipient).toBe(SUBJECT_EMAIL);
    expect(shared?.appointmentId).toBeNull();
  });

  it("discloses only the staff display name, never the staff member's own record", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });
    const serialised = JSON.stringify(document);

    expect(document.appointments[0]?.staffDisplayName).toBe("Simona");
    for (const secret of [
      "Colour specialist, private staff biography",
      "+390472999888",
      "simona@group.calendar.google.com",
      "user-simona",
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("keeps staff identities out of the audit trail it hands over", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });
    const serialised = JSON.stringify(document);

    expect(document.auditTrail.map((row) => row.id).sort()).toEqual([
      "audit-subject-appointment",
      "audit-subject-self-service",
      "audit-subject-update",
    ]);
    expect(document.auditTrail[0]).not.toHaveProperty("actorEmail");
    expect(serialised).not.toContain("simona@hairsimo.it");
    expect(serialised).not.toContain("Mozilla/5.0");
    expect(serialised).not.toContain("10.0.0.9");
  });

  it("never hands out the booking verification credential", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(document.bookingVerifications).toHaveLength(1);
    expect(document.bookingVerifications[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(document)).not.toContain(
      "b8f1c0a9deadbeefcafefeed00000000deadbeefcafefeed0000000011112222",
    );
  });
});

describe("export document shape", () => {
  it("pins the schema version and the salon time zone", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(CUSTOMER_EXPORT_SCHEMA_VERSION).toBe("hair-simo.gdpr.customer-export/1");
    expect(document.schemaVersion).toBe(CUSTOMER_EXPORT_SCHEMA_VERSION);
    expect(document.timeZone).toBe("Europe/Rome");
    expect(Object.keys(document).sort()).toEqual(
      [
        "appointmentStatusHistory",
        "appointments",
        "auditTrail",
        "bookingVerifications",
        "callLogs",
        "consentRecords",
        "conversations",
        "counts",
        "customer",
        "customerNotes",
        "dataRequests",
        "generatedAt",
        "locale",
        "notifications",
        "payments",
        "recurringSeries",
        "reviewRequests",
        "schemaVersion",
        "subjectId",
        "timeZone",
        "vouchers",
        "waitlistEntries",
      ].sort(),
    );
  });

  it("dates every instant twice: absolute and salon wall clock", async () => {
    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });

    expect(document.generatedAt.iso).toBe("2026-07-29T09:00:00.000Z");
    expect(document.generatedAt.salon).toContain("11:00");
    expect(document.appointments[0]?.startsAt).toEqual({
      iso: "2026-03-04T09:00:00.000Z",
      salon: expect.stringContaining("10:00"),
    });
  });

  it("names the download file by salon day, not by host day", async () => {
    const lateEvening = new Date("2026-07-29T22:30:00.000Z");
    const result = await service.exportCustomerDataAsJson(SUBJECT, { now: lateEvening });

    expect(result.filename).toBe(`hair-simo-data-export-${SUBJECT}-2026-07-30.json`);
    expect(result.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(result.body).schemaVersion).toBe(CUSTOMER_EXPORT_SCHEMA_VERSION);
  });

  it("records the access request it answered", async () => {
    const { dataRequestId } = await service.exportCustomerData(SUBJECT, {
      now: NOW,
      requestedBy: "simona@hairsimo.it",
    });
    const created = db.rows("dataRequest").find((row) => row.id === dataRequestId);

    expect(created).toMatchObject({ customerId: SUBJECT, type: "export", status: "completed" });
    expect(JSON.parse(String(created?.resultLocation)).schemaVersion).toBe(
      CUSTOMER_EXPORT_SCHEMA_VERSION,
    );
  });

  it("completes a pre-existing request instead of opening a second one", async () => {
    const before = db.rows("dataRequest").length;
    const { dataRequestId } = await service.exportCustomerData(SUBJECT, {
      now: NOW,
      dataRequestId: "req-subject-1",
    });

    expect(dataRequestId).toBe("req-subject-1");
    expect(db.rows("dataRequest")).toHaveLength(before);
    expect(db.find("dataRequest", "req-subject-1")).toMatchObject({
      status: "completed",
      completedAt: NOW,
    });
  });

  it("leaves no trace when the caller asks for a dry read", async () => {
    const before = db.rows("dataRequest").length;
    const { dataRequestId } = await service.exportCustomerData(SUBJECT, {
      now: NOW,
      recordRequest: false,
    });

    expect(dataRequestId).toBeNull();
    expect(db.rows("dataRequest")).toHaveLength(before);
  });
});

describe("erasure (Art. 17)", () => {
  it("destroys every direct identifier in every table", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW, requestedBy: "simona@hairsimo.it" });

    expect(independentScan(SUBJECT_NEEDLES)).toEqual([]);

    const customer = subjectRow();
    expect(customer.email).toBeNull();
    expect(customer.phone).toBeNull();
    expect(customer.firstName).toBe("Erased");
    expect(String(customer.lastName)).toMatch(/^Customer [0-9a-f]{8}$/);
    expect(customer.marketingOptIn).toBe(false);
    expect(customer.anonymizedAt).toEqual(NOW);
    expect(customer.deletedAt).toEqual(NOW);

    expect(db.rows("customerNote").map((row) => row.id)).toEqual(["note-third-1"]);
    expect(db.rows("bookingVerification").map((row) => row.id)).toEqual(["ver-third-1"]);
    expect(db.find("message", "msg-subject-1").content).toBe(ERASURE_REDACTION_MARKER);
    expect(db.find("message", "msg-subject-1").metadata).toEqual({ redacted: "gdpr-erasure" });
    expect(db.find("conversation", "conv-subject").externalRef).toBeNull();
    expect(db.find("callLog", "call-subject-linked").summary).toBe(ERASURE_REDACTION_MARKER);
    expect(db.find("callLog", "call-subject-linked").fromNumber).toBeNull();
    expect(db.find("notificationLog", "notif-subject-apt").recipient).toBe(ERASURE_REDACTION_MARKER);
    expect(db.find("appointment", "apt-subject-1").notes).toBeNull();
    expect(db.find("appointment", "apt-subject-2").cancellationReason).toBeNull();
    expect(db.find("appointmentStatusHistory", "hist-subject-1").reason).toBeNull();
    expect(db.find("voucher", "vou-subject-1").note).toBeNull();
    expect(db.find("auditLog", "audit-subject-update").before).toEqual({ redacted: "gdpr-erasure" });
  });

  it("erases a call log linked to the subject only by their phone number", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });

    const unlinked = db.find("callLog", "call-subject-unlinked");
    expect(unlinked.fromNumber).toBeNull();
    expect(unlinked.summary).toBe(ERASURE_REDACTION_MARKER);
  });

  it("does not write the subject's own address back into the accountability records", async () => {
    const result = await service.eraseCustomerData(SUBJECT, {
      now: NOW,
      requestedBy: SUBJECT_EMAIL,
    });

    expect(result.receipt.requestedBy).toBe(ERASURE_SUBJECT_ACTOR);
    expect(db.find("dataRequest", "req-subject-1").requestedBy).toBe(ERASURE_SUBJECT_ACTOR);
    expect(independentScan([SUBJECT_EMAIL])).toEqual([]);
  });

  it("scrubs the subject's contacts out of the caller's free-text reason", async () => {
    const { receipt } = await service.eraseCustomerData(SUBJECT, {
      now: NOW,
      reason: `wrote from ${SUBJECT_EMAIL}, confirmed on ${SUBJECT_PHONE}`,
    });

    expect(receipt.reason).toBe(
      `wrote from ${ERASURE_REDACTION_MARKER}, confirmed on ${ERASURE_REDACTION_MARKER}`,
    );
    expect(independentScan([SUBJECT_EMAIL, SUBJECT_PHONE])).toEqual([]);
  });

  it("keeps a genuine staff requester on the record", async () => {
    const result = await service.eraseCustomerData(SUBJECT, {
      now: NOW,
      requestedBy: "simona@hairsimo.it",
      reason: "subject request received by post",
    });
    const audit = db.rows("auditLog").find((row) => row.action === "gdpr.customer.erasure");

    expect(result.receipt.requestedBy).toBe("simona@hairsimo.it");
    expect(result.receipt.reason).toBe("subject request received by post");
    expect(audit).toMatchObject({ actorEmail: "simona@hairsimo.it", entityId: SUBJECT });
  });

  it("touches nothing that belongs to the other customer", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });

    expect(db.find("customer", OTHER)).toMatchObject({
      email: OTHER_EMAIL,
      phone: OTHER_PHONE,
      firstName: "Luca",
      anonymizedAt: null,
    });
    expect(db.find("customerNote", "note-third-1").note).toBe("Luca Bianchi prefers the 18:00 slot");
    expect(db.find("appointment", "apt-third-1").notes).toBe("Luca wants a fade");
    expect(db.find("callLog", "call-third").summary).toBe("Luca asked about opening hours");
    expect(db.find("notificationLog", "notif-third").recipient).toBe(OTHER_PHONE);
    expect(db.find("appointmentStatusHistory", "hist-third-1").reason).toBe(
      "confirmed by luca.bianchi@example.it",
    );
    expect(db.find("auditLog", "audit-third").before).toEqual({ email: OTHER_EMAIL });
    expect(db.find("refund", "ref-third-1").reason).toBe("duplicate charge");
  });

  it("keeps the accounting skeleton Italian law requires", async () => {
    const { receipt } = await service.eraseCustomerData(SUBJECT, { now: NOW });

    expect(db.rows("appointment").map((row) => row.id)).toEqual([
      "apt-subject-1",
      "apt-subject-2",
      "apt-third-1",
    ]);
    expect(db.find("appointment", "apt-subject-1")).toMatchObject({
      customerId: SUBJECT,
      serviceId: "svc-cut",
      status: "completed",
      startsAt: new Date("2026-03-04T09:00:00.000Z"),
    });
    expect(db.find("payment", "pay-subject-1")).toMatchObject({
      amountCents: 4500,
      tipCents: 500,
      refundedCents: 1000,
      currency: "EUR",
      status: "paid",
    });
    expect(db.find("refund", "ref-subject-1")).toMatchObject({
      amountCents: 1000,
      providerRefId: "re_1",
    });
    expect(db.find("voucherRedemption", "red-subject-own").amountCents).toBe(3_000);
    expect(db.rows("reviewRequest").map((row) => row.id)).toContain("rev-subject-1");

    const classes = receipt.retained.map((entry) => entry.dataClass);
    expect(classes).toEqual([
      "appointments",
      "payments",
      "refunds",
      "consentRecords",
      "voucherRedemptions",
      "reviewRequests",
      "dataRequests",
      "auditTrail",
    ]);
    for (const entry of receipt.retained) {
      expect(entry.legalBasis.length).toBeGreaterThan(20);
      expect(entry.retainedFor.length).toBeGreaterThan(5);
    }
    expect(receipt.retained.find((entry) => entry.dataClass === "payments")?.records).toBe(1);
    expect(receipt.retained.find((entry) => entry.dataClass === "refunds")?.records).toBe(1);
  });

  it("stops future automated processing", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });

    expect(db.find("recurringSeries", "series-subject-1").active).toBe(false);
    expect(db.find("waitlist", "wait-subject-1").status).toBe("cancelled");
    expect(db.find("waitlist", "wait-third-1").status).toBe("active");
  });

  it("frees the unique email and phone so the person can come back as a new customer", async () => {
    await expect(
      db.client("customer").create({
        data: { id: "cus-returning", email: SUBJECT_EMAIL, firstName: "A", lastName: "B" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await service.eraseCustomerData(SUBJECT, { now: NOW });

    const returning = await db.client("customer").create({
      data: {
        id: "cus-returning",
        email: SUBJECT_EMAIL,
        phone: SUBJECT_PHONE,
        firstName: SUBJECT_FIRST,
        lastName: SUBJECT_LAST,
      },
    });
    expect(returning).toMatchObject({ id: "cus-returning", email: SUBJECT_EMAIL });
    expect(await service.findLiveCustomer("cus-returning")).toMatchObject({ email: SUBJECT_EMAIL });
    expect(await service.findLiveCustomer(SUBJECT)).toBeNull();
  });

  it("rejects an unknown subject without writing anything", async () => {
    const before = JSON.stringify(db.tables);
    await expect(service.eraseCustomerData("nobody", { now: NOW })).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );
    expect(JSON.stringify(db.tables)).toBe(before);
  });
});

describe("erasure receipt shape", () => {
  it("pins the receipt contract", async () => {
    const { receipt } = await service.eraseCustomerData(SUBJECT, {
      now: NOW,
      requestedBy: "simona@hairsimo.it",
      reason: "postal request",
    });

    expect(receipt.schemaVersion).toBe(ERASURE_RECEIPT_SCHEMA_VERSION);
    expect(Object.keys(receipt).sort()).toEqual([
      "alreadyErased",
      "customerId",
      "erasedAt",
      "identifiers",
      "reason",
      "removed",
      "requestedBy",
      "retained",
      "schemaVersion",
      "timeZone",
    ]);
    expect(Object.keys(receipt.identifiers).sort()).toEqual([
      "emailCleared",
      "nameReplaced",
      "phoneCleared",
      "placeholderSuffix",
    ]);
    expect(Object.keys(receipt.removed).sort()).toEqual([
      "appointmentsRedacted",
      "auditEntriesRedacted",
      "bookingVerificationsDeleted",
      "callLogsRedacted",
      "consentMetadataRedacted",
      "conversationsRedacted",
      "customerNotesDeleted",
      "messagesRedacted",
      "notificationLogsRedacted",
      "recurringSeriesStopped",
      "refundReasonsRedacted",
      "statusHistoryRedacted",
      "voucherNotesRedacted",
      "waitlistEntriesCancelled",
    ]);
    expect(Object.keys(receipt.retained[0] ?? {}).sort()).toEqual([
      "dataClass",
      "legalBasis",
      "records",
      "retainedFor",
    ]);
    expect(receipt.erasedAt).toEqual({
      iso: "2026-07-29T09:00:00.000Z",
      salon: expect.stringContaining("11:00"),
    });
    expect(receipt.timeZone).toBe("Europe/Rome");
  });

  it("counts what it actually changed", async () => {
    const { receipt } = await service.eraseCustomerData(SUBJECT, { now: NOW });

    expect(receipt.removed).toMatchObject({
      customerNotesDeleted: 1,
      bookingVerificationsDeleted: 1,
      messagesRedacted: 1,
      conversationsRedacted: 1,
      callLogsRedacted: 2,
      notificationLogsRedacted: 3,
      appointmentsRedacted: 2,
      statusHistoryRedacted: 1,
      voucherNotesRedacted: 1,
      refundReasonsRedacted: 1,
      consentMetadataRedacted: 1,
      recurringSeriesStopped: 1,
      waitlistEntriesCancelled: 1,
    });
    expect(receipt.removed.auditEntriesRedacted).toBeGreaterThan(0);
    expect(receipt.identifiers.placeholderSuffix).toMatch(/^[0-9a-f]{8}$/);
  });

  it("derives the placeholder from nothing the erased values can reproduce", async () => {
    const first = await service.eraseCustomerData(SUBJECT, { now: NOW });
    db.reset();
    seedWorld();
    const second = await service.eraseCustomerData(SUBJECT, { now: NOW });

    expect(first.receipt.identifiers.placeholderSuffix).not.toBe(
      second.receipt.identifiers.placeholderSuffix,
    );
  });
});

describe("erasure atomicity and idempotence", () => {
  it("runs in exactly one transaction", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rolls the whole erasure back when the final write fails", async () => {
    db.failNext("auditLog.create");

    await expect(service.eraseCustomerData(SUBJECT, { now: NOW })).rejects.toThrow(
      "INJECTED_FAILURE:auditLog.create",
    );

    expect(subjectRow()).toMatchObject({
      email: SUBJECT_EMAIL,
      phone: SUBJECT_PHONE,
      firstName: SUBJECT_FIRST,
      lastName: SUBJECT_LAST,
      anonymizedAt: null,
    });
    expect(db.rows("customerNote").map((row) => row.id)).toContain("note-subject-1");
    expect(db.find("message", "msg-subject-1").content).toContain(SUBJECT_FIRST);
    expect(db.find("callLog", "call-subject-linked").fromNumber).toBe(SUBJECT_PHONE);
    expect(db.find("recurringSeries", "series-subject-1").active).toBe(true);
    expect(db.rows("bookingVerification").map((row) => row.id)).toContain("ver-subject-1");
    expect(db.rows("auditLog").some((row) => row.action === "gdpr.customer.erasure")).toBe(false);
  });

  it("is idempotent: a second run changes no identifier", async () => {
    const first = await service.eraseCustomerData(SUBJECT, { now: NOW });
    const afterFirst = JSON.stringify(subjectRow());

    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await service.eraseCustomerData(SUBJECT, { now: later });

    expect(first.alreadyErased).toBe(false);
    expect(second.alreadyErased).toBe(true);
    expect(second.receipt.identifiers.placeholderSuffix).toBeNull();
    expect(second.receipt.erasedAt.iso).toBe(first.receipt.erasedAt.iso);
    expect(JSON.stringify(subjectRow())).toBe(afterFirst);
    expect(independentScan(SUBJECT_NEEDLES)).toEqual([]);
  });

  it("keeps one anonymisation when two erasure requests race", async () => {
    const [first, second] = await Promise.all([
      service.eraseCustomerData(SUBJECT, { now: NOW, recordRequest: false }),
      service.eraseCustomerData(SUBJECT, { now: NOW, recordRequest: false }),
    ]);

    const suffixes = [first, second]
      .map((run) => run.receipt.identifiers.placeholderSuffix)
      .filter((value): value is string => value !== null);
    expect(suffixes).toHaveLength(1);
    expect(subjectRow().lastName).toBe(`Customer ${suffixes[0]}`);
    expect([first.alreadyErased, second.alreadyErased].sort()).toEqual([false, true]);
    expect(db.rows("customer").filter((row) => row.anonymizedAt !== null)).toHaveLength(1);
    expect(independentScan(SUBJECT_NEEDLES)).toEqual([]);
  });

  it("completes the pending erasure request rather than opening another", async () => {
    const before = db.rows("dataRequest").length;
    const { dataRequestId } = await service.eraseCustomerData(SUBJECT, {
      now: NOW,
      dataRequestId: "req-subject-1",
    });

    expect(dataRequestId).toBe("req-subject-1");
    expect(db.rows("dataRequest")).toHaveLength(before);
    const stored = db.find("dataRequest", "req-subject-1");
    expect(stored).toMatchObject({ status: "completed", completedAt: NOW });
    expect(JSON.parse(String(stored.resultLocation)).schemaVersion).toBe(
      ERASURE_RECEIPT_SCHEMA_VERSION,
    );
  });
});

describe("residue verification", () => {
  it("reports clean after a real erasure", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });

    const verification = await service.verifyErasure(SUBJECT, SUBJECT_IDENTIFIERS, { now: NOW });

    expect(verification.residues).toEqual([]);
    expect(verification.clean).toBe(true);
    expect(verification.truncated).toBe(false);
    expect(verification.identifiersChecked).toEqual([
      SUBJECT_EMAIL,
      SUBJECT_PHONE,
      `${SUBJECT_FIRST} ${SUBJECT_LAST}`,
    ]);
    expect(verification.checkedAt.iso).toBe("2026-07-29T09:00:00.000Z");
  });

  it("reports dirty before the erasure runs", async () => {
    const verification = await service.verifyErasure(SUBJECT, SUBJECT_IDENTIFIERS, { now: NOW });

    expect(verification.clean).toBe(false);
    const seen = new Set(verification.residues.map((row) => `${row.dataClass}.${row.field}`));
    expect(seen).toContain("customer.email");
    expect(seen).toContain("customer.phone");
    expect(seen).toContain("customerNote.note");
    expect(seen).toContain("appointment.notes");
    expect(seen).toContain("message.content");
    expect(seen).toContain("callLog.summary");
    expect(seen).toContain("conversation.externalRef");
    expect(seen).toContain("voucher.note");
    expect(seen).toContain("auditLog.actorEmail");
    expect(seen).toContain("consentRecord.metadata");
  });

  it("finds the subject's full name still sitting in a customer row", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });
    db.find("customer", OTHER).firstName = SUBJECT_FIRST;
    db.find("customer", OTHER).lastName = SUBJECT_LAST;

    const verification = await service.verifyErasure(SUBJECT, SUBJECT_IDENTIFIERS, { now: NOW });

    expect(verification.clean).toBe(false);
    expect(verification.residues).toContainEqual({
      dataClass: "customer",
      recordId: OTHER,
      field: "lastName",
      identifier: `${SUBJECT_FIRST} ${SUBJECT_LAST}`,
    });
  });

  it("finds an identifier a staff member typed into a retained accounting record", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });
    db.find("refund", "ref-subject-1").reason = `chargeback opened by ${SUBJECT_EMAIL}`;
    db.find("dataRequest", "req-subject-1").requestedBy = SUBJECT_EMAIL;

    const verification = await service.verifyErasure(SUBJECT, SUBJECT_IDENTIFIERS, { now: NOW });

    expect(verification.clean).toBe(false);
    const seen = verification.residues.map((row) => `${row.dataClass}.${row.field}`);
    expect(seen).toContain("refund.reason");
    expect(seen).toContain("dataRequest.requestedBy");
  });

  it("caps a flood of residues and says so", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });
    for (let index = 0; index < 205; index += 1) {
      insert("customerNote", {
        id: `leak-${index}`,
        customerId: OTHER,
        note: `copied contact ${SUBJECT_EMAIL}`,
      });
    }

    const verification = await service.verifyErasure(SUBJECT, SUBJECT_IDENTIFIERS, { now: NOW });

    expect(verification.truncated).toBe(true);
    expect(verification.residues).toHaveLength(200);
    expect(verification.clean).toBe(false);
  });

  it("treats a scan with nothing to look for as vacuously clean", async () => {
    const verification = await service.verifyErasure(SUBJECT, { email: null, phone: "  " }, {
      now: NOW,
    });

    expect(verification).toMatchObject({
      customerId: SUBJECT,
      clean: true,
      identifiersChecked: [],
      residues: [],
      truncated: false,
    });
  });

  /**
   * The erasure's own audit entry is proof that the erasure happened, so the JSON scan
   * skips `gdpr.*` rows. That exclusion is also the one blind spot left: a free-text
   * `reason` naming the subject is persisted into that row and will not be reported.
   */
  it("skips its own proof-of-erasure audit entry, blind spot included", async () => {
    await service.eraseCustomerData(SUBJECT, {
      now: NOW,
      reason: `${SUBJECT_FIRST} ${SUBJECT_LAST} asked in the salon`,
    });

    const verification = await service.verifyErasure(SUBJECT, SUBJECT_IDENTIFIERS, { now: NOW });
    expect(verification.residues.filter((row) => row.dataClass === "auditLog")).toEqual([]);

    const audit = db.rows("auditLog").find((row) => row.action === "gdpr.customer.erasure");
    expect(JSON.stringify(audit)).toContain(`${SUBJECT_FIRST} ${SUBJECT_LAST}`);
  });
});

describe("consent (Art. 7)", () => {
  it("records a withdrawal and flips the flag", async () => {
    const result = await service.withdrawMarketingConsent(SUBJECT, "admin-ui", {
      metadata: { by: "simona@hairsimo.it" },
      now: NOW,
    });

    expect(result).toMatchObject({ customerId: SUBJECT, granted: false, changed: true });
    expect(subjectRow().marketingOptIn).toBe(false);

    const written = db.find("consentRecord", result.consentRecordId);
    expect(written).toMatchObject({
      customerId: SUBJECT,
      type: MARKETING_CONSENT_TYPE,
      granted: false,
      source: "admin-ui",
    });
    expect(db.rows("consentRecord").map((row) => row.id)).toContain("consent-subject-1");
  });

  it("reports changed=false when the withdrawal repeats an existing state", async () => {
    await service.withdrawMarketingConsent(SUBJECT, "admin-ui", { now: NOW });
    const second = await service.withdrawMarketingConsent(SUBJECT, "admin-ui", { now: NOW });

    expect(second.changed).toBe(false);
    expect(db.rows("consentRecord").filter((row) => row.customerId === SUBJECT)).toHaveLength(3);
  });

  it("keeps the flag and the newest record in step when grants race", async () => {
    await Promise.all([
      service.setMarketingConsent(SUBJECT, true, "web", { now: NOW }),
      service.setMarketingConsent(SUBJECT, false, "email-unsubscribe", { now: NOW }),
    ]);

    const history = await service.readConsentHistory(SUBJECT);
    expect(history.marketingFlagDrift).toBe(false);
    expect(history.current[0]?.granted).toBe(history.marketingOptIn);
    expect(history.entries).toHaveLength(3);
  });

  it("rejects an empty source", async () => {
    await expect(service.setMarketingConsent(SUBJECT, true, "   ", { now: NOW })).rejects.toThrow();
  });

  it("surfaces a flag that drifted away from the newest record", async () => {
    subjectRow().marketingOptIn = false;

    const history = await service.readConsentHistory(SUBJECT);

    expect(history.marketingOptIn).toBe(false);
    expect(history.current[0]).toMatchObject({ type: MARKETING_CONSENT_TYPE, granted: true });
    expect(history.marketingFlagDrift).toBe(true);
  });

  it("orders history newest first and reduces it to one state per type", async () => {
    await service.setMarketingConsent(SUBJECT, false, "email-unsubscribe", { now: NOW });
    await service.setMarketingConsent(SUBJECT, true, "in-salon-form", { now: NOW });

    const history = await service.readConsentHistory(SUBJECT);

    expect(history.entries.map((row) => row.source)).toEqual([
      "in-salon-form",
      "email-unsubscribe",
      "web-checkout",
    ]);
    expect(history.current).toHaveLength(1);
    expect(history.current[0]).toMatchObject({ source: "in-salon-form", granted: true });
  });

  it("keeps the consent proof through erasure and strips only its metadata", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });

    const record = db.find("consentRecord", "consent-subject-1");
    expect(record).toMatchObject({
      customerId: SUBJECT,
      type: MARKETING_CONSENT_TYPE,
      granted: true,
      source: "web-checkout",
    });
    expect(record.metadata).toEqual({ redacted: "gdpr-erasure" });

    const history = await service.readConsentHistory(SUBJECT);
    expect(history.entries.map((row) => row.id)).toContain("consent-subject-1");
    expect(history.marketingOptIn).toBe(false);
  });
});

describe("visibility of an erased customer", () => {
  it("hides an anonymised customer from normal reads", async () => {
    expect(await service.findLiveCustomer(SUBJECT)).toMatchObject({ email: SUBJECT_EMAIL });

    await service.eraseCustomerData(SUBJECT, { now: NOW });

    expect(await service.findLiveCustomer(SUBJECT)).toBeNull();
    expect(LIVE_CUSTOMER_WHERE).toEqual({ deletedAt: null, anonymizedAt: null });
  });

  it("hides a merely soft-deleted customer too", async () => {
    subjectRow().deletedAt = new Date("2026-07-01T00:00:00.000Z");
    expect(await service.findLiveCustomer(SUBJECT)).toBeNull();
  });

  it("refuses to take fresh consent for an erased customer", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });

    await expect(service.setMarketingConsent(SUBJECT, true, "web", { now: NOW })).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );
    expect(subjectRow().marketingOptIn).toBe(false);
  });

  it("still answers subject-rights reads for an erased customer", async () => {
    await service.eraseCustomerData(SUBJECT, { now: NOW });

    const { document } = await service.exportCustomerData(SUBJECT, { now: NOW });
    expect(document.customer.email).toBeNull();
    expect(document.customer.firstName).toBe("Erased");
    expect(document.counts.payments).toBe(1);
  });
});

describe("data request bookkeeping", () => {
  it("creates, lists and fails a request", async () => {
    const created = await service.createDataRequest({
      customerId: SUBJECT,
      type: "export",
      requestedBy: "simona@hairsimo.it",
    });
    expect(created).toMatchObject({ customerId: SUBJECT, type: "export", status: "pending" });

    const listed = await service.listDataRequests({ customerId: SUBJECT, status: "pending" });
    expect(listed.map((row) => row.id)).toEqual([created.id, "req-subject-1"]);

    const failed = await service.failDataRequest(created.id, "x".repeat(2_000));
    expect(failed.status).toBe("failed");
    expect(failed.error).toHaveLength(1_000);
  });

  it("clamps the page size", async () => {
    await service.listDataRequests({ take: 10_000 });
    const call = db.client("dataRequest").findMany.mock.calls.at(-1)?.[0] as Args;
    expect(call.take).toBe(200);

    await service.listDataRequests({ take: -5 });
    const clamped = db.client("dataRequest").findMany.mock.calls.at(-1)?.[0] as Args;
    expect(clamped.take).toBe(1);
  });

  it("rejects a blank customer id everywhere", async () => {
    await expect(service.exportCustomerData("   ")).rejects.toThrow();
    await expect(service.eraseCustomerData("   ")).rejects.toThrow();
    await expect(service.readConsentHistory("")).rejects.toThrow();
    await expect(service.findLiveCustomer("")).rejects.toThrow();
  });
});
