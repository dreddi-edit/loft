import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

type Model =
  | "appointment"
  | "appointmentStatusHistory"
  | "payment"
  | "refund"
  | "conversation"
  | "message"
  | "callLog"
  | "notificationLog"
  | "auditLog"
  | "consentRecord"
  | "bookingVerification"
  | "waitlist"
  | "reviewRequest"
  | "dataRequest"
  | "voucher"
  | "voucherRedemption";

const { db } = vi.hoisted(() => {
  const models = [
    "appointment",
    "appointmentStatusHistory",
    "payment",
    "refund",
    "conversation",
    "message",
    "callLog",
    "notificationLog",
    "auditLog",
    "consentRecord",
    "bookingVerification",
    "waitlist",
    "reviewRequest",
    "dataRequest",
    "voucher",
    "voucherRedemption",
  ] as const;
  type Name = (typeof models)[number];

  const tables = {} as Record<Name, Row[]>;
  for (const model of models) tables[model] = [];

  // Anchored to the suite's NOW. A 1970 epoch would make every "older than the cutoff"
  // comparison trivially true and no retention window could ever be observed.
  const NOW_MS = Date.parse("2026-07-29T09:00:00.000Z");
  let sequence = 0;
  function tick(): Date {
    sequence += 1;
    return new Date(NOW_MS + sequence);
  }

  function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
  }

  /** Ordering used by both the comparison operators and orderBy, so a keyset cursor on
   * `id` walks the same sequence the sort produced. */
  function compare(left: unknown, right: unknown): number | null {
    const a = comparable(left);
    const b = comparable(right);
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
    return null;
  }

  function matchOperators(actual: unknown, expected: Row): boolean {
    const entries = Object.entries(expected);
    if (entries.length === 0) return true;
    return entries.every(([operator, operand]) => {
      switch (operator) {
        case "equals":
          return matchValue(actual, operand);
        case "not":
          if (operand === null) return actual !== null && actual !== undefined;
          return !matchValue(actual, operand);
        case "in":
          return (operand as unknown[]).some((value) => matchValue(actual, value));
        case "notIn":
          return !(operand as unknown[]).some((value) => matchValue(actual, value));
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
          if (actual === null || actual === undefined) return false;
          const delta = compare(actual, operand);
          if (delta === null) return false;
          if (operator === "lt") return delta < 0;
          if (operator === "lte") return delta <= 0;
          if (operator === "gt") return delta > 0;
          return delta >= 0;
        }
        case "startsWith":
          return typeof actual === "string" && actual.startsWith(String(operand));
        case "contains":
          return typeof actual === "string" && actual.includes(String(operand));
        default:
          throw new Error(`unsupported operator ${operator}`);
      }
    });
  }

  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return comparable(actual) === expected.getTime();
    if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
    if (typeof expected === "object") return matchOperators(actual, expected as Row);
    return actual === expected;
  }

  function clauses(value: unknown): Row[] {
    return Array.isArray(value) ? (value as Row[]) : [value as Row];
  }

  function matchWhere(model: Name, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      if (key === "AND") return clauses(expected).every((clause) => matchWhere(model, row, clause));
      if (key === "OR") return clauses(expected).some((clause) => matchWhere(model, row, clause));
      if (key === "NOT") return !clauses(expected).some((clause) => matchWhere(model, row, clause));
      if (key === "messages") {
        const condition = expected as { none?: Row; some?: Row; every?: Row };
        const children = tables.message.filter((child) => child.conversationId === row.id);
        if (condition.none !== undefined) {
          return !children.some((child) => matchWhere("message", child, condition.none));
        }
        if (condition.some !== undefined) {
          return children.some((child) => matchWhere("message", child, condition.some));
        }
        if (condition.every !== undefined) {
          return children.every((child) => matchWhere("message", child, condition.every));
        }
        throw new Error("unsupported relation filter");
      }
      return matchValue(row[key], expected);
    });
  }

  function sortRows(rows: Row[], orderBy: unknown): Row[] {
    const sorted = [...rows];
    if (!orderBy) return sorted;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    sorted.sort((left, right) => {
      for (const spec of specs) {
        for (const [key, direction] of Object.entries(spec)) {
          const delta = compare(left[key], right[key]) ?? 0;
          if (delta !== 0) return direction === "desc" ? -delta : delta;
        }
      }
      return 0;
    });
    return sorted;
  }

  const CASCADES: Partial<
    Record<Name, { model: Name; fk: string; mode: "cascade" | "setNull" }[]>
  > = {
    conversation: [{ model: "message", fk: "conversationId", mode: "cascade" }],
    appointment: [
      { model: "appointmentStatusHistory", fk: "appointmentId", mode: "cascade" },
      { model: "payment", fk: "appointmentId", mode: "cascade" },
      { model: "bookingVerification", fk: "appointmentId", mode: "cascade" },
      { model: "reviewRequest", fk: "appointmentId", mode: "cascade" },
      { model: "notificationLog", fk: "appointmentId", mode: "setNull" },
      { model: "voucherRedemption", fk: "appointmentId", mode: "setNull" },
    ],
    payment: [
      { model: "refund", fk: "paymentId", mode: "cascade" },
      { model: "voucherRedemption", fk: "paymentId", mode: "setNull" },
    ],
    voucher: [{ model: "voucherRedemption", fk: "voucherId", mode: "cascade" }],
  };

  function removeRows(model: Name, victims: Row[]): void {
    if (victims.length === 0) return;
    const ids = new Set(victims.map((row) => row.id as string));
    const table = tables[model];
    for (let index = table.length - 1; index >= 0; index -= 1) {
      const row = table[index] as Row;
      if (ids.has(row.id as string)) table.splice(index, 1);
    }
    for (const link of CASCADES[model] ?? []) {
      if (link.mode === "setNull") {
        for (const row of tables[link.model]) {
          if (ids.has(row[link.fk] as string)) row[link.fk] = null;
        }
        continue;
      }
      removeRows(
        link.model,
        tables[link.model].filter((row) => ids.has(row[link.fk] as string)),
      );
    }
  }

  const mutations: string[] = [];

  function delegate(model: Name) {
    const notImplemented = (method: string) =>
      vi.fn(async () => {
        mutations.push(`${model}.${method}`);
        throw new Error(`${model}.${method} is not part of the retention sweeper's surface`);
      });
    return {
      findMany: vi.fn(async (args: Row = {}) => {
        await Promise.resolve();
        const rows = tables[model].filter((row) => matchWhere(model, row, args.where as Row));
        const sorted = sortRows(rows, args.orderBy);
        const take = args.take as number | undefined;
        return (take === undefined ? sorted : sorted.slice(0, take)).map((row) => ({ ...row }));
      }),
      count: vi.fn(async (args: Row = {}) => {
        await Promise.resolve();
        return tables[model].filter((row) => matchWhere(model, row, args.where as Row)).length;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        await Promise.resolve();
        mutations.push(`${model}.deleteMany`);
        const victims = tables[model].filter((row) => matchWhere(model, row, where));
        removeRows(model, victims);
        return { count: victims.length };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        await Promise.resolve();
        mutations.push(`${model}.updateMany`);
        const targets = tables[model].filter((row) => matchWhere(model, row, where));
        for (const row of targets) {
          for (const [key, value] of Object.entries(data)) row[key] = value;
          row.updatedAt = tick();
        }
        return { count: targets.length };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        await Promise.resolve();
        mutations.push(`${model}.create`);
        const stamp = tick();
        const row: Row = {
          id: `${model}-auto-${sequence}`,
          createdAt: stamp,
          updatedAt: stamp,
          ...data,
        };
        tables[model].push(row);
        return { ...row };
      }),
      update: notImplemented("update"),
      delete: notImplemented("delete"),
      upsert: notImplemented("upsert"),
      createMany: notImplemented("createMany"),
    };
  }

  const delegates = {} as Record<Name, ReturnType<typeof delegate>>;
  for (const model of models) delegates[model] = delegate(model);

  return {
    db: {
      prisma: delegates,
      tables,
      mutations,
      reset() {
        for (const model of models) tables[model].length = 0;
        mutations.length = 0;
        sequence = 0;
      },
      snapshot() {
        return JSON.stringify(tables);
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

import {
  DataRetentionService,
  LEGAL_RETENTION_FLOOR_DAYS,
  RETENTION_CLASS_KEYS,
  RETENTION_REDACTION_MARKER,
  RetentionError,
  dataRetentionService,
  retentionCutoff,
  retentionPolicy,
  type ClassSweepReport,
  type RetentionClassKey,
  type RetentionPolicy,
  type SweepOptions,
} from "./data-retention";

const NOW = new Date("2026-07-29T09:00:00.000Z");
const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland"];
const originalHostZone = process.env.TZ;

function cleanPolicy(overrides: Record<string, string> = {}): RetentionPolicy {
  return retentionPolicy(overrides);
}

function ruleDays(key: RetentionClassKey, env: Record<string, string> = {}): number {
  const rule = cleanPolicy(env).rules.find((entry) => entry.key === key);
  if (!rule) throw new Error(`no retention rule for ${key}`);
  return rule.days;
}

/** An instant safely outside the retention window of `key`. */
function aged(key: RetentionClassKey, extraDays = 5): Date {
  const cutoff = retentionCutoff(NOW, ruleDays(key));
  return new Date(cutoff.getTime() - extraDays * 86_400_000);
}

/** An instant safely inside the retention window of `key`. */
function fresh(key: RetentionClassKey, backDays = 1): Date {
  const cutoff = retentionCutoff(NOW, ruleDays(key));
  return new Date(cutoff.getTime() + backDays * 86_400_000);
}

function seed(model: Model, rows: Row[]): void {
  for (const row of rows) {
    db.tables[model].push({
      createdAt: NOW,
      updatedAt: NOW,
      ...row,
    });
  }
}

function rowById(model: Model, id: string): Row | undefined {
  return db.tables[model].find((row) => row.id === id);
}

function ids(model: Model): string[] {
  return db.tables[model].map((row) => row.id as string).sort();
}

async function sweep(overrides: SweepOptions = {}) {
  return dataRetentionService.sweep({
    now: NOW,
    policy: cleanPolicy(),
    recordAudit: false,
    ...overrides,
  });
}

function classReport(
  report: { classes: ClassSweepReport[] },
  key: RetentionClassKey,
): ClassSweepReport {
  const entry = report.classes.find((item) => item.dataClass === key);
  if (!entry) throw new Error(`no report for ${key}`);
  return entry;
}

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalHostZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostZone;
});

describe("policy declaration", () => {
  it("declares a period, a floor and a written reason for every data class", () => {
    const policy = cleanPolicy();
    expect(policy.rules).toHaveLength(RETENTION_CLASS_KEYS.length);
    expect(policy.timeZone).toBe("Europe/Rome");

    for (const rule of policy.rules) {
      expect(rule.days).toBeGreaterThanOrEqual(rule.floorDays);
      expect(rule.floorDays).toBeGreaterThanOrEqual(1);
      expect(rule.envVar.startsWith("RETENTION_")).toBe(true);
      expect(rule.models.length).toBeGreaterThan(0);
      expect(rule.rationale.length).toBeGreaterThan(80);
      expect(rule.clampedFromDays).toBeNull();
    }
  });

  it("keeps the legal classes at the accounting floor and the operational ones short", () => {
    const days = (key: RetentionClassKey) => ruleDays(key);
    expect(days("appointments")).toBe(LEGAL_RETENTION_FLOOR_DAYS);
    expect(days("vouchers")).toBe(LEGAL_RETENTION_FLOOR_DAYS);
    expect(days("auditLogs")).toBe(730);
    expect(days("auditLogPayloads")).toBeLessThan(days("auditLogs"));
    for (const key of ["conversations", "callLogs", "notificationLogs"] as const) {
      expect(days(key)).toBeLessThanOrEqual(365);
    }
    expect(days("bookingVerifications")).toBeLessThanOrEqual(30);
  });

  it("takes a period from the environment", () => {
    expect(ruleDays("callLogs", { RETENTION_CALL_LOG_DAYS: "45" })).toBe(45);
    expect(ruleDays("callLogs", { RETENTION_CALL_LOG_DAYS: "  45  " })).toBe(45);
    expect(ruleDays("callLogs", { RETENTION_CALL_LOG_DAYS: "" })).toBe(365);
  });

  it("refuses a period that is not a whole positive number of days", () => {
    for (const raw of ["0", "-1", "12.5", "abc", "1e9", "NaN", "Infinity"]) {
      expect(() => cleanPolicy({ RETENTION_CALL_LOG_DAYS: raw })).toThrow(RetentionError);
    }
    try {
      cleanPolicy({ RETENTION_CALL_LOG_DAYS: "0" });
      throw new Error("expected a RetentionError");
    } catch (error) {
      expect((error as RetentionError).code).toBe("RETENTION_PERIOD_INVALID");
    }
  });

  it("validates the environment at module load, not at the first cron tick", async () => {
    vi.resetModules();
    vi.stubEnv("RETENTION_CALL_LOG_DAYS", "not-a-number");
    try {
      await expect(import("./data-retention")).rejects.toThrow("RETENTION_CALL_LOG_DAYS");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("date boundaries", () => {
  it("cuts at salon midnight rather than at the hour the cron happened to fire", () => {
    const cutoff = retentionCutoff(NOW, 365);
    expect(cutoff.toISOString()).toBe("2025-07-28T22:00:00.000Z");

    // 20:45 UTC is 22:45 in Bressanone, still the same salon day as 09:00 UTC.
    const later = retentionCutoff(new Date("2026-07-29T20:45:00.000Z"), 365);
    expect(later.toISOString()).toBe(cutoff.toISOString());
  });

  it("counts calendar days across a DST change, not 24-hour blocks", () => {
    const springForward = new Date("2026-04-05T10:00:00.000Z");
    const cutoff = retentionCutoff(springForward, 14);

    // 22 March 2026 is still CET (UTC+1); 5 April is already CEST (UTC+2).
    expect(cutoff.toISOString()).toBe("2026-03-21T23:00:00.000Z");

    const naive = new Date(springForward.getTime() - 14 * 86_400_000);
    expect(naive.toISOString()).toBe("2026-03-22T10:00:00.000Z");
    expect(cutoff.getTime()).not.toBe(naive.getTime());
  });

  it("lands on the same instant whatever the host time zone is", () => {
    const lateEvening = new Date("2026-07-29T23:30:00.000Z");
    const results = HOST_ZONES.map((zone) => {
      process.env.TZ = zone;
      return [
        retentionCutoff(NOW, 90).toISOString(),
        retentionCutoff(lateEvening, 90).toISOString(),
      ].join("|");
    });
    expect(new Set(results).size).toBe(1);

    // 23:30 UTC is already the next salon day in Bressanone, so the window shifts by one.
    expect(retentionCutoff(NOW, 90).toISOString()).toBe("2026-04-29T22:00:00.000Z");
    expect(retentionCutoff(lateEvening, 90).toISOString()).toBe("2026-04-30T22:00:00.000Z");
  });

  it("refuses a period that is not a whole number of days", () => {
    expect(() => retentionCutoff(NOW, 0)).toThrow(RetentionError);
    expect(() => retentionCutoff(NOW, 1.5)).toThrow(RetentionError);
  });
});

describe("operational classes", () => {
  it("sweeps a dead conversation but never truncates a live one", async () => {
    const old = aged("conversations");
    seed("conversation", [
      { id: "conv-1", customerId: "cus-1", channel: "whatsapp", createdAt: old },
      { id: "conv-2", customerId: "cus-1", channel: "whatsapp", createdAt: old },
      { id: "conv-3", customerId: "cus-1", channel: "web", createdAt: fresh("conversations") },
    ]);
    seed("message", [
      { id: "msg-1", conversationId: "conv-1", content: "meine Mutter ist krank", createdAt: old },
      { id: "msg-2", conversationId: "conv-2", content: "alter Anfang", createdAt: old },
      { id: "msg-3", conversationId: "conv-2", content: "immer noch aktiv", createdAt: NOW },
      { id: "msg-4", conversationId: "conv-3", content: "neu", createdAt: NOW },
    ]);

    const report = await sweep({ classes: ["conversations"] });

    expect(classReport(report, "conversations").removed).toBe(1);
    expect(ids("conversation")).toEqual(["conv-2", "conv-3"]);
    expect(ids("message")).toEqual(["msg-2", "msg-3", "msg-4"]);
  });

  it("keeps a notification that is still queued for delivery, whatever its age", async () => {
    const old = aged("notificationLogs");
    seed("notificationLog", [
      { id: "note-1", status: "sent", recipient: "a@example.com", createdAt: old },
      { id: "note-2", status: "failed", recipient: "b@example.com", createdAt: old },
      { id: "note-3", status: "pending", recipient: "c@example.com", createdAt: old },
      { id: "note-4", status: "sent", recipient: "d@example.com", createdAt: fresh("notificationLogs") },
    ]);

    const report = await sweep({ classes: ["notificationLogs"] });

    expect(classReport(report, "notificationLogs").removed).toBe(2);
    expect(ids("notificationLog")).toEqual(["note-3", "note-4"]);
  });

  it("ages call logs off on their own createdAt", async () => {
    seed("callLog", [
      { id: "call-1", summary: "wants a colour", createdAt: aged("callLogs") },
      { id: "call-2", summary: "cancelled", createdAt: fresh("callLogs") },
    ]);

    await sweep({ classes: ["callLogs"] });

    expect(ids("callLog")).toEqual(["call-2"]);
  });

  it("ages verification tokens off their expiry, not their creation", async () => {
    const veryOld = new Date("2024-01-01T00:00:00.000Z");
    seed("bookingVerification", [
      { id: "ver-1", appointmentId: "app-1", createdAt: veryOld, expiresAt: aged("bookingVerifications") },
      { id: "ver-2", appointmentId: "app-2", createdAt: veryOld, expiresAt: fresh("bookingVerifications") },
    ]);

    await sweep({ classes: ["bookingVerifications"] });

    expect(ids("bookingVerification")).toEqual(["ver-2"]);
  });

  it("never sweeps a waitlist entry that is still waiting", async () => {
    const old = aged("waitlistEntries");
    seed("waitlist", [
      { id: "wait-1", status: "cancelled", updatedAt: old },
      { id: "wait-2", status: "expired", updatedAt: old },
      { id: "wait-3", status: "converted", updatedAt: old },
      { id: "wait-4", status: "active", updatedAt: old },
      { id: "wait-5", status: "notified", updatedAt: old },
    ]);

    const report = await sweep({ classes: ["waitlistEntries"] });

    expect(classReport(report, "waitlistEntries").removed).toBe(3);
    expect(ids("waitlist")).toEqual(["wait-4", "wait-5"]);
  });

  it("keeps review requests at least as long as the ask cooldown", async () => {
    expect(ruleDays("reviewRequests")).toBeGreaterThanOrEqual(730);
    seed("reviewRequest", [
      { id: "rev-1", appointmentId: "app-1", createdAt: aged("reviewRequests") },
      { id: "rev-2", appointmentId: "app-2", createdAt: fresh("reviewRequests") },
    ]);

    await sweep({ classes: ["reviewRequests"] });

    expect(ids("reviewRequest")).toEqual(["rev-2"]);
  });

  it("sweeps an export request but keeps the proof that an erasure was carried out", async () => {
    const old = aged("dataRequests");
    seed("dataRequest", [
      { id: "req-1", customerId: "cus-1", type: "export", status: "completed", createdAt: old },
      { id: "req-2", customerId: "cus-1", type: "erasure", status: "completed", createdAt: old },
    ]);

    await sweep({ classes: ["dataRequests"] });

    expect(ids("dataRequest")).toEqual(["req-2"]);
  });
});

describe("audit trail", () => {
  function seedAudit(): void {
    const old = aged("auditLogPayloads");
    seed("auditLog", [
      {
        id: "audit-1",
        action: "appointment.update",
        actorEmail: "simo@hairsimo.it",
        actorRole: "owner",
        entityType: "appointment",
        entityId: "app-1",
        ip: "62.101.4.12",
        userAgent: "Mozilla/5.0",
        before: { notes: "Anna Gruber, Balayage" },
        after: { notes: "Anna Gruber, Balayage + Schnitt" },
        createdAt: old,
      },
      {
        id: "audit-2",
        action: "gdpr.customer.erasure",
        actorEmail: "system@hairsimo.it",
        actorRole: "system",
        entityType: "customer",
        entityId: "cus-1",
        ip: "10.0.0.1",
        userAgent: "cron",
        before: null,
        after: { schemaVersion: "hair-simo.gdpr.erasure-receipt/1" },
        createdAt: old,
      },
      {
        id: "audit-3",
        action: "appointment.cancel",
        actorEmail: "simo@hairsimo.it",
        actorRole: "owner",
        entityType: "appointment",
        entityId: "app-2",
        ip: "62.101.4.12",
        userAgent: "Mozilla/5.0",
        before: { status: "confirmed" },
        after: { status: "cancelled" },
        createdAt: fresh("auditLogPayloads"),
      },
    ]);
  }

  it("redacts the session identifiers and the snapshots but leaves the action readable", async () => {
    seedAudit();

    const report = await sweep({ classes: ["auditLogPayloads"] });

    const redacted = rowById("auditLog", "audit-1") as Row;
    expect(redacted.ip).toBeNull();
    expect(redacted.userAgent).toBeNull();
    expect(redacted.before).toEqual({ redacted: "retention" });
    expect(redacted.after).toEqual({ redacted: "retention" });
    expect(redacted.action).toBe("appointment.update");
    expect(redacted.actorEmail).toBe("simo@hairsimo.it");
    expect(redacted.entityId).toBe("app-1");

    expect(classReport(report, "auditLogPayloads").redacted).toBe(3);
    expect(classReport(report, "auditLogPayloads").removed).toBe(0);
  });

  it("does not touch the erasure receipt or an entry inside the incident window", async () => {
    seedAudit();

    await sweep({ classes: ["auditLogPayloads"] });

    const proof = rowById("auditLog", "audit-2") as Row;
    expect(proof.ip).toBe("10.0.0.1");
    expect(proof.after).toEqual({ schemaVersion: "hair-simo.gdpr.erasure-receipt/1" });

    const recent = rowById("auditLog", "audit-3") as Row;
    expect(recent.ip).toBe("62.101.4.12");
    expect(recent.before).toEqual({ status: "confirmed" });
  });

  it("settles: a second sweep finds nothing left to redact", async () => {
    seedAudit();

    await sweep({ classes: ["auditLogPayloads"] });
    const second = await sweep({ classes: ["auditLogPayloads"] });

    expect(classReport(second, "auditLogPayloads").redacted).toBe(0);
  });

  it("deletes old entries but never the gdpr ones", async () => {
    const old = aged("auditLogs");
    seed("auditLog", [
      { id: "audit-old", action: "appointment.update", createdAt: old, before: null, after: null, ip: null, userAgent: null },
      { id: "audit-gdpr", action: "gdpr.customer.erasure", createdAt: old, before: null, after: null, ip: null, userAgent: null },
      { id: "audit-new", action: "appointment.update", createdAt: fresh("auditLogs"), before: null, after: null, ip: null, userAgent: null },
    ]);

    await sweep({ classes: ["auditLogs"] });

    expect(ids("auditLog")).toEqual(["audit-gdpr", "audit-new"]);
  });

  it("records the sweep it just performed", async () => {
    seed("callLog", [{ id: "call-1", summary: "x", createdAt: aged("callLogs") }]);

    await sweep({ classes: ["callLogs"], recordAudit: true });

    const written = db.tables.auditLog.filter((row) => row.action === "retention.sweep");
    expect(written).toHaveLength(1);
    expect(written[0]?.actorRole).toBe("system");
    expect(JSON.stringify(written[0]?.after)).toContain("callLogs");
  });
});

describe("consent records", () => {
  const marketing = (id: string, granted: boolean, createdAt: Date, customerId = "cus-1"): Row => ({
    id,
    customerId,
    type: "marketing",
    granted,
    source: "web",
    createdAt,
  });

  it("removes a withdrawn chain once the proof window has passed", async () => {
    const old = aged("consentRecords", 10);
    seed("consentRecord", [
      marketing("con-1", true, new Date(old.getTime() - 86_400_000)),
      marketing("con-2", false, old),
    ]);

    const report = await sweep({ classes: ["consentRecords"] });

    expect(classReport(report, "consentRecords").removed).toBe(2);
    expect(db.tables.consentRecord).toHaveLength(0);
  });

  it("keeps the whole chain when the customer opted back in afterwards", async () => {
    const old = aged("consentRecords", 10);
    seed("consentRecord", [
      marketing("con-1", true, new Date(old.getTime() - 2 * 86_400_000)),
      marketing("con-2", false, new Date(old.getTime() - 86_400_000)),
      marketing("con-3", true, old),
    ]);

    const report = await sweep({ classes: ["consentRecords"] });

    expect(classReport(report, "consentRecords").removed).toBe(0);
    expect(ids("consentRecord")).toEqual(["con-1", "con-2", "con-3"]);
  });

  it("keeps a withdrawal that is still inside the proof window", async () => {
    seed("consentRecord", [marketing("con-1", false, fresh("consentRecords"))]);

    await sweep({ classes: ["consentRecords"] });

    expect(ids("consentRecord")).toEqual(["con-1"]);
  });

  it("scopes the removal to one consent type and one customer", async () => {
    const old = aged("consentRecords", 10);
    seed("consentRecord", [
      marketing("con-1", false, old),
      { id: "con-2", customerId: "cus-1", type: "review", granted: true, source: "web", createdAt: old },
      marketing("con-3", true, old, "cus-2"),
    ]);

    await sweep({ classes: ["consentRecords"] });

    expect(ids("consentRecord")).toEqual(["con-2", "con-3"]);
  });
});

describe("vouchers", () => {
  const expired = (extra: number) => aged("vouchers", extra);

  it("never sweeps a voucher that still has a balance, however long it has been expired", async () => {
    seed("voucher", [
      { id: "vou-live", code: "AAA", initialCents: 5_000, remainingCents: 2_500, expiresAt: expired(400) },
      { id: "vou-spent", code: "BBB", initialCents: 5_000, remainingCents: 0, expiresAt: expired(400) },
      { id: "vou-open", code: "CCC", initialCents: 5_000, remainingCents: 0, expiresAt: null },
      { id: "vou-recent", code: "DDD", initialCents: 5_000, remainingCents: 0, expiresAt: fresh("vouchers") },
    ]);
    seed("voucherRedemption", [
      { id: "red-1", voucherId: "vou-spent", amountCents: 5_000, createdAt: expired(400) },
    ]);

    const report = await sweep({ classes: ["vouchers"] });

    expect(classReport(report, "vouchers").removed).toBe(1);
    expect(ids("voucher")).toEqual(["vou-live", "vou-open", "vou-recent"]);
    expect(db.tables.voucherRedemption).toHaveLength(0);
  });

  it("holds the claims window at the accounting floor", () => {
    expect(ruleDays("vouchers")).toBe(LEGAL_RETENTION_FLOOR_DAYS);
  });
});

describe("legal records", () => {
  function seedLegalSkeleton(): void {
    const inWindow = fresh("appointmentFreeText");
    seed("appointment", [
      {
        id: "app-old",
        customerId: "cus-1",
        serviceId: "svc-1",
        status: "completed",
        startsAt: aged("appointments", 400),
        endsAt: aged("appointments", 400),
        notes: "Farbe 7.1 mit 6% Oxid",
        cancellationReason: null,
      },
      {
        id: "app-recent",
        customerId: "cus-1",
        serviceId: "svc-1",
        status: "cancelled",
        startsAt: inWindow,
        endsAt: inWindow,
        notes: "Anna hat Migräne erwähnt",
        cancellationReason: "krank gemeldet",
      },
    ]);
    seed("payment", [
      { id: "pay-old", appointmentId: "app-old", amountCents: 8_500, status: "paid", createdAt: aged("appointments", 400) },
      { id: "pay-recent", appointmentId: "app-recent", amountCents: 4_500, status: "refunded", createdAt: inWindow },
    ]);
    seed("refund", [
      { id: "ref-recent", paymentId: "pay-recent", amountCents: 4_500, reason: "Anna Gruber war unzufrieden", createdAt: aged("refundReasons") },
    ]);
    seed("appointmentStatusHistory", [
      { id: "hist-1", appointmentId: "app-recent", status: "cancelled", reason: "Anna rief an, Mutter im Krankenhaus", createdAt: aged("statusHistoryReasons") },
      { id: "hist-2", appointmentId: "app-recent", status: "confirmed", reason: "telefonisch bestätigt", createdAt: fresh("statusHistoryReasons") },
    ]);
    seed("notificationLog", [
      { id: "note-old", appointmentId: "app-old", status: "sent", recipient: "anna@example.com", createdAt: fresh("notificationLogs") },
    ]);
  }

  it("redacts free text off rows the accounting rules keep, without touching the figures", async () => {
    seedLegalSkeleton();

    const report = await sweep({
      classes: ["appointmentFreeText", "statusHistoryReasons", "refundReasons"],
    });

    const appointment = rowById("appointment", "app-old") as Row;
    expect(appointment.notes).toBe(RETENTION_REDACTION_MARKER);
    expect(appointment.status).toBe("completed");
    expect(appointment.customerId).toBe("cus-1");

    const history = rowById("appointmentStatusHistory", "hist-1") as Row;
    expect(history.reason).toBe(RETENTION_REDACTION_MARKER);
    expect(history.status).toBe("cancelled");

    const refund = rowById("refund", "ref-recent") as Row;
    expect(refund.reason).toBe(RETENTION_REDACTION_MARKER);
    expect(refund.amountCents).toBe(4_500);
    expect(refund.paymentId).toBe("pay-recent");

    expect(classReport(report, "appointmentFreeText").removed).toBe(0);
    expect(classReport(report, "refundReasons").redacted).toBe(1);
  });

  it("leaves free text inside its window alone and settles after one pass", async () => {
    seedLegalSkeleton();

    await sweep({ classes: ["appointmentFreeText", "statusHistoryReasons", "refundReasons"] });

    expect((rowById("appointment", "app-recent") as Row).notes).toBe("Anna hat Migräne erwähnt");
    expect((rowById("appointmentStatusHistory", "hist-2") as Row).reason).toBe(
      "telefonisch bestätigt",
    );

    const second = await sweep({
      classes: ["appointmentFreeText", "statusHistoryReasons", "refundReasons"],
    });
    expect(classReport(second, "appointmentFreeText").redacted).toBe(0);
    expect(classReport(second, "statusHistoryReasons").redacted).toBe(0);
    expect(classReport(second, "refundReasons").redacted).toBe(0);
  });

  it("removes an appointment past the accounting floor together with everything hanging off it", async () => {
    seedLegalSkeleton();

    const report = await sweep({ classes: ["appointments"] });

    expect(classReport(report, "appointments").removed).toBe(1);
    expect(ids("appointment")).toEqual(["app-recent"]);
    expect(ids("payment")).toEqual(["pay-recent"]);
    expect((rowById("notificationLog", "note-old") as Row).appointmentId).toBeNull();
  });
});

describe("the legal floor beats the environment", () => {
  it("clamps a reckless environment variable and says so", () => {
    const policy = cleanPolicy({ RETENTION_APPOINTMENTS_DAYS: "30" });
    const rule = policy.rules.find((entry) => entry.key === "appointments");
    expect(rule?.days).toBe(LEGAL_RETENTION_FLOOR_DAYS);
    expect(rule?.clampedFromDays).toBe(30);
  });

  it("keeps a five-year-old invoice even when the environment asks for one day", async () => {
    seed("appointment", [
      { id: "app-5y", customerId: "cus-1", startsAt: new Date("2021-07-29T08:00:00.000Z"), status: "completed" },
      { id: "app-12y", customerId: "cus-1", startsAt: new Date("2014-07-29T08:00:00.000Z"), status: "completed" },
    ]);

    const report = await sweep({
      classes: ["appointments"],
      policy: cleanPolicy({ RETENTION_APPOINTMENTS_DAYS: "1" }),
    });

    expect(ids("appointment")).toEqual(["app-5y"]);
    expect(classReport(report, "appointments").retentionDays).toBe(LEGAL_RETENTION_FLOOR_DAYS);
    expect(classReport(report, "appointments").guard).toEqual({
      requestedDays: 1,
      enforcedDays: LEGAL_RETENTION_FLOOR_DAYS,
    });
  });

  it("re-applies the floor from its own table when a hand-built policy tries to shorten it", async () => {
    seed("appointment", [
      { id: "app-5y", customerId: "cus-1", startsAt: new Date("2021-07-29T08:00:00.000Z"), status: "completed" },
    ]);
    seed("voucher", [
      { id: "vou-5y", code: "AAA", initialCents: 5_000, remainingCents: 0, expiresAt: new Date("2021-07-29T08:00:00.000Z") },
    ]);

    const tampered = cleanPolicy();
    for (const rule of tampered.rules) {
      if (rule.key === "appointments" || rule.key === "vouchers") {
        rule.days = 1;
        rule.floorDays = 1;
        rule.clampedFromDays = null;
      }
    }

    const report = await sweep({ classes: ["appointments", "vouchers"], policy: tampered });

    expect(ids("appointment")).toEqual(["app-5y"]);
    expect(ids("voucher")).toEqual(["vou-5y"]);
    for (const key of ["appointments", "vouchers"] as const) {
      const entry = classReport(report, key);
      expect(entry.retentionDays).toBe(LEGAL_RETENTION_FLOOR_DAYS);
      expect(entry.guard).toEqual({ requestedDays: 1, enforcedDays: LEGAL_RETENTION_FLOOR_DAYS });
      expect(entry.removed).toBe(0);
    }
  });
});

describe("dry run", () => {
  function seedEverything(): void {
    seed("callLog", [
      { id: "call-1", summary: "one", createdAt: aged("callLogs") },
      { id: "call-2", summary: "two", createdAt: aged("callLogs") },
    ]);
    seed("conversation", [{ id: "conv-1", customerId: "cus-1", createdAt: aged("conversations") }]);
    seed("message", [
      { id: "msg-1", conversationId: "conv-1", content: "hallo", createdAt: aged("conversations") },
    ]);
    seed("notificationLog", [
      { id: "note-1", status: "sent", recipient: "a@example.com", createdAt: aged("notificationLogs") },
    ]);
    seed("waitlist", [{ id: "wait-1", status: "cancelled", updatedAt: aged("waitlistEntries") }]);
    seed("bookingVerification", [
      { id: "ver-1", appointmentId: "app-1", expiresAt: aged("bookingVerifications") },
    ]);
    seed("reviewRequest", [
      { id: "rev-1", appointmentId: "app-1", createdAt: aged("reviewRequests") },
    ]);
    seed("dataRequest", [
      { id: "req-1", customerId: "cus-1", type: "export", createdAt: aged("dataRequests") },
    ]);
    seed("auditLog", [
      {
        id: "audit-1",
        action: "appointment.update",
        actorEmail: "simo@hairsimo.it",
        ip: "62.101.4.12",
        userAgent: "Mozilla/5.0",
        before: { a: 1 },
        after: { a: 2 },
        createdAt: aged("auditLogs"),
      },
    ]);
    seed("consentRecord", [
      {
        id: "con-1",
        customerId: "cus-1",
        type: "marketing",
        granted: false,
        source: "web",
        createdAt: aged("consentRecords", 10),
      },
    ]);
    seed("appointment", [
      {
        id: "app-1",
        customerId: "cus-1",
        status: "completed",
        startsAt: aged("appointments", 400),
        notes: "Farbe 7.1",
        cancellationReason: "krank",
      },
    ]);
    seed("appointmentStatusHistory", [
      {
        id: "hist-1",
        appointmentId: "app-1",
        status: "completed",
        reason: "abgeschlossen",
        createdAt: aged("statusHistoryReasons"),
      },
    ]);
    seed("refund", [
      { id: "ref-1", paymentId: "pay-1", amountCents: 100, reason: "kulanz", createdAt: aged("refundReasons") },
    ]);
    seed("voucher", [
      { id: "vou-1", code: "AAA", initialCents: 5_000, remainingCents: 0, expiresAt: aged("vouchers", 400) },
    ]);
  }

  it("changes nothing at all", async () => {
    seedEverything();
    const before = db.snapshot();

    const report = await dataRetentionService.previewSweep({ now: NOW, policy: cleanPolicy() });

    expect(report.dryRun).toBe(true);
    expect(db.mutations).toEqual([]);
    expect(db.snapshot()).toBe(before);
    expect(report.removed).toBeGreaterThan(0);
    expect(report.redacted).toBeGreaterThan(0);
  });

  it("does not even write its own audit entry", async () => {
    seedEverything();

    await dataRetentionService.previewSweep({
      now: NOW,
      policy: cleanPolicy(),
      recordAudit: true,
    });

    expect(db.tables.auditLog.some((row) => row.action === "retention.sweep")).toBe(false);
  });

  it("reports exactly the counts the real sweep then produces", async () => {
    seedEverything();

    const preview = await dataRetentionService.previewSweep({ now: NOW, policy: cleanPolicy() });
    const live = await sweep();

    for (const key of RETENTION_CLASS_KEYS) {
      expect({
        key,
        removed: classReport(live, key).removed,
        redacted: classReport(live, key).redacted,
      }).toEqual({
        key,
        removed: classReport(preview, key).removed,
        redacted: classReport(preview, key).redacted,
      });
    }
    expect(live.removed).toBe(preview.removed);
    expect(live.redacted).toBe(preview.redacted);
  });
});

describe("batching", () => {
  function seedCallLogs(count: number): void {
    seed(
      "callLog",
      Array.from({ length: count }, (_unused, index) => ({
        id: `call-${String(index).padStart(3, "0")}`,
        summary: `call ${index}`,
        createdAt: aged("callLogs"),
      })),
    );
  }

  it("never asks the database to delete more than one batch at a time", async () => {
    seedCallLogs(25);

    const report = await sweep({ classes: ["callLogs"], batchSize: 10 });

    expect(classReport(report, "callLogs").removed).toBe(25);
    expect(classReport(report, "callLogs").batches).toBe(3);
    expect(db.tables.callLog).toHaveLength(0);
    for (const call of db.prisma.callLog.deleteMany.mock.calls) {
      const where = (call[0] as { where: { id: { in: string[] } } }).where;
      expect(where.id.in.length).toBeLessThanOrEqual(10);
    }
  });

  it("stops at the ceiling and asks to be called again", async () => {
    seedCallLogs(25);

    const report = await sweep({ classes: ["callLogs"], batchSize: 10, maxBatchesPerClass: 2 });

    expect(classReport(report, "callLogs").removed).toBe(20);
    expect(classReport(report, "callLogs").moreRemaining).toBe(true);
    expect(report.incomplete).toBe(true);
    expect(db.tables.callLog).toHaveLength(5);

    const rest = await sweep({ classes: ["callLogs"], batchSize: 10 });
    expect(classReport(rest, "callLogs").removed).toBe(5);
    expect(rest.incomplete).toBe(false);
  });

  it("terminates on a dry run even though nothing shrinks the candidate set", async () => {
    seedCallLogs(25);

    const report = await dataRetentionService.previewSweep({
      now: NOW,
      policy: cleanPolicy(),
      classes: ["callLogs"],
      batchSize: 10,
    });

    expect(classReport(report, "callLogs").removed).toBe(25);
    expect(classReport(report, "callLogs").batches).toBe(3);
    expect(db.tables.callLog).toHaveLength(25);
  });
});

describe("adversarial", () => {
  it("counts a row once when two cron ticks overlap", async () => {
    seed(
      "callLog",
      Array.from({ length: 6 }, (_unused, index) => ({
        id: `call-${index}`,
        summary: `call ${index}`,
        createdAt: aged("callLogs"),
      })),
    );

    const [first, second] = await Promise.all([
      sweep({ classes: ["callLogs"], batchSize: 3 }),
      sweep({ classes: ["callLogs"], batchSize: 3 }),
    ]);

    const removed =
      classReport(first, "callLogs").removed + classReport(second, "callLogs").removed;
    expect(removed).toBe(6);
    expect(db.tables.callLog).toHaveLength(0);
  });

  it("keeps sweeping the other classes when one of them fails", async () => {
    seed("callLog", [{ id: "call-1", summary: "one", createdAt: aged("callLogs") }]);
    seed("reviewRequest", [
      { id: "rev-1", appointmentId: "app-1", createdAt: aged("reviewRequests") },
    ]);
    db.prisma.callLog.findMany.mockRejectedValueOnce(new Error("canceling statement due to lock"));

    const report = await sweep({ classes: ["callLogs", "reviewRequests"] });

    expect(report.errors).toEqual([
      { dataClass: "callLogs", message: "canceling statement due to lock" },
    ]);
    expect(report.incomplete).toBe(true);
    expect(classReport(report, "reviewRequests").removed).toBe(1);
    expect(db.tables.callLog).toHaveLength(1);
    expect(db.tables.reviewRequest).toHaveLength(0);
  });

  it("refuses an unknown data class instead of silently sweeping everything", async () => {
    await expect(
      sweep({ classes: ["customers" as RetentionClassKey] }),
    ).rejects.toThrow(RetentionError);
  });

  it("refuses a batch size that would defeat the point of batching", async () => {
    await expect(sweep({ batchSize: 0 })).rejects.toThrow();
    await expect(sweep({ batchSize: 1_000_000 })).rejects.toThrow();
  });

  it("does the same work whatever the host time zone is", async () => {
    const outcomes: string[] = [];
    for (const zone of HOST_ZONES) {
      db.reset();
      process.env.TZ = zone;
      seed("callLog", [
        { id: "call-old", summary: "old", createdAt: new Date("2025-07-28T21:59:00.000Z") },
        { id: "call-edge", summary: "edge", createdAt: new Date("2025-07-28T22:00:00.000Z") },
      ]);
      const report = await sweep({ classes: ["callLogs"] });
      outcomes.push(`${report.classes[0]?.cutoffSalonDay}:${ids("callLog").join(",")}`);
    }
    expect(new Set(outcomes)).toEqual(new Set(["2025-07-29:call-edge"]));
  });
});

describe("service surface", () => {
  it("exposes the policy for the admin screen", () => {
    const service = new DataRetentionService();
    const policy = service.policy({});
    expect(policy.legalFloorDays).toBe(LEGAL_RETENTION_FLOOR_DAYS);
    expect(policy.rules.map((rule) => rule.key)).toEqual([...RETENTION_CLASS_KEYS]);
  });

  it("reports a cutoff per class in both absolute and salon terms", async () => {
    const report = await sweep({ classes: ["callLogs"] });
    const entry = classReport(report, "callLogs");
    expect(entry.cutoff.toISOString()).toBe("2025-07-28T22:00:00.000Z");
    expect(entry.cutoffSalonDay).toBe("2025-07-29");
    expect(entry.models).toEqual(["CallLog"]);
    expect(entry.action).toBe("delete");
  });
});
