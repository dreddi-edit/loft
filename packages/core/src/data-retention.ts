/**
 * Storage limitation (GDPR Art. 5(1)(e)) for a salon in Bressanone / Brixen (IT).
 *
 * Nothing in this system deletes itself. Chat transcripts, call summaries, delivery
 * receipts and audit entries accumulate forever, which is both a cost and — once the
 * operational purpose has lapsed — an unlawful holding of personal data. This module is
 * the counterweight: a declared retention period per data class, a batched sweeper the
 * cron endpoint can call, and a dry run so the owner can see what a change to the policy
 * would actually destroy before it destroys it.
 *
 * Three rules shape every decision here.
 *
 * 1. A period is a number of WHOLE SALON DAYS, and the boundary is salon midnight. Not
 *    "now minus N times 86 400 000 ms": that boundary drifts by an hour twice a year and
 *    lands mid-afternoon, so the same row is retained for a different length of time
 *    depending on what time the cron happened to fire. Every cutoff goes through
 *    {@link salonDayKey} / {@link parseSalonDay}.
 * 2. Removal of a record inside a legal retention window is impossible, not merely
 *    discouraged. `RETENTION_APPOINTMENTS_DAYS=1` in the environment does not delete
 *    last week's invoices; it is clamped to {@link LEGAL_RETENTION_FLOOR_DAYS} at load,
 *    and the sweeper re-applies the floor from its own static table so a hand-built
 *    policy object cannot beat it either.
 * 3. Where a row must survive for referential or legal reasons but carries free text
 *    about a person, the free text is REDACTED and the row stays. An appointment is the
 *    business record behind an invoice; the stylist's note on it is not.
 *
 * Deliberately NOT swept: Customer, Payment, Refund, VoucherRedemption. Those either are
 * the accounting record itself or hang off it, and they leave only as a cascade of an
 * Appointment old enough to be past the accounting floor. Erasure of a living customer is
 * `gdpr-service.ts`, which anonymises rather than deletes for exactly the same reason.
 */

import { z } from "zod";
import { prisma } from "@hair-simo/db";
import type { Prisma } from "@hair-simo/db";
import { SALON_TIME_ZONE, parseSalonDay, salonDayKey } from "./time";

/** Written over free text that a surviving row may no longer carry. */
export const RETENTION_REDACTION_MARKER = "[redacted:retention]";

const RETENTION_ACTOR_EMAIL = "system@hairsimo.it";
const RETENTION_AUDIT_ACTION = "retention.sweep";

/** Audit entries proving a GDPR erasure happened outlive every retention rule. */
const GDPR_AUDIT_PREFIX = "gdpr.";

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES_PER_CLASS = 20;
const MAX_BATCHES_PER_CLASS = 1_000;
const MAX_RETENTION_DAYS = 36_525;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Eleven years.
 *
 * Codice Civile art. 2220 and DPR 633/1972 art. 39 require accounting books, invoices and
 * VAT documentation to be kept for ten years counted from the END OF THE FINANCIAL YEAR
 * in which the entry arose. This sweeper measures age from the row's own timestamp
 * instead, which is up to one calendar year earlier than the legal clock starts, so ten
 * years from `startsAt` can still be inside the ten years from the year end. The extra
 * year closes that gap without needing fiscal-year arithmetic in a cron job.
 */
export const LEGAL_RETENTION_FLOOR_DAYS = 4_018;

export class RetentionError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "RetentionError";
    this.code = code;
  }
}

export type RetentionCategory = "operational" | "accountability" | "consent" | "legal";

export type RetentionAction = "delete" | "redact";

export type RetentionClassKey =
  | "auditLogPayloads"
  | "appointmentFreeText"
  | "statusHistoryReasons"
  | "refundReasons"
  | "bookingVerifications"
  | "waitlistEntries"
  | "notificationLogs"
  | "callLogs"
  | "conversations"
  | "dataRequests"
  | "reviewRequests"
  | "auditLogs"
  | "consentRecords"
  | "vouchers"
  | "appointments";

type RuleDefinition = {
  key: RetentionClassKey;
  category: RetentionCategory;
  action: RetentionAction;
  envVar: string;
  defaultDays: number;
  /**
   * Lowest period this class may ever run at. For a class that DELETES a row the law
   * requires the salon to keep, this is {@link LEGAL_RETENTION_FLOOR_DAYS}. For a class
   * that only redacts free text off such a row it is not: redacting a stylist's note
   * destroys no accounting record, so the floor there is a sanity guard, not a legal one.
   */
  floorDays: number;
  models: string[];
  /** Column the age of a row is measured from. */
  anchor: string;
  rationale: string;
};

/**
 * Order matters. Cheap redactions run before the expensive cascading deletes, and
 * `appointments` runs last because removing one takes its status history, payments and
 * refunds with it — if the run is cut short by the batch ceiling, everything else has
 * already had its turn.
 */
const RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    key: "auditLogPayloads",
    category: "accountability",
    action: "redact",
    envVar: "RETENTION_AUDIT_PAYLOAD_DAYS",
    defaultDays: 90,
    floorDays: 30,
    models: ["AuditLog"],
    anchor: "createdAt",
    rationale:
      "The IP, the user agent and the before/after snapshots are what make an audit " +
      "entry investigable, and they are also the most personal thing on it — for a " +
      "salon employee as much as for a customer. Ninety days covers the window in " +
      "which a security incident is actually detected and reconstructed; after that " +
      "the WHO, WHAT and WHEN carry the accountability duty on their own.",
  },
  {
    key: "appointmentFreeText",
    category: "legal",
    action: "redact",
    envVar: "RETENTION_APPOINTMENT_TEXT_DAYS",
    defaultDays: 730,
    floorDays: 365,
    models: ["Appointment"],
    anchor: "startsAt",
    rationale:
      "The appointment row is the business record behind an invoice and must be kept " +
      "for the accounting period, but `notes` and `cancellationReason` are free text a " +
      "member of staff typed about a person and are no part of that record. Two years " +
      "is longer than any regular customer's visit interval, so nothing a returning " +
      "client would expect us to remember is lost while they are still a client.",
  },
  {
    key: "statusHistoryReasons",
    category: "legal",
    action: "redact",
    envVar: "RETENTION_STATUS_REASON_DAYS",
    defaultDays: 730,
    floorDays: 365,
    models: ["AppointmentStatusHistory"],
    anchor: "createdAt",
    rationale:
      "The status transitions themselves are evidence for a no-show fee or a refund " +
      "dispute and stay. The typed reason beside them ('called, said her mother is in " +
      "hospital') is not evidence of anything after two years, and is exactly the kind " +
      "of special-category detail that must not sit in a table forever.",
  },
  {
    key: "refundReasons",
    category: "legal",
    action: "redact",
    envVar: "RETENTION_REFUND_REASON_DAYS",
    defaultDays: 730,
    floorDays: 365,
    models: ["Refund"],
    anchor: "createdAt",
    rationale:
      "A refund is a correction of an accounting entry: the amount, the payment and the " +
      "date are the record and are never touched here. The free-text reason is not part " +
      "of the accounting document and follows the same two-year rule as the rest of the " +
      "operational free text.",
  },
  {
    key: "bookingVerifications",
    category: "operational",
    action: "delete",
    envVar: "RETENTION_BOOKING_VERIFICATION_DAYS",
    defaultDays: 30,
    floorDays: 7,
    models: ["BookingVerification"],
    anchor: "expiresAt",
    rationale:
      "A token hash whose deadline has passed can never verify anything again. Thirty " +
      "days past expiry is enough to answer 'did the confirmation link ever go out' " +
      "while a customer might still be asking, and keeping a credential-shaped row any " +
      "longer is pure attack surface.",
  },
  {
    key: "waitlistEntries",
    category: "operational",
    action: "delete",
    envVar: "RETENTION_WAITLIST_DAYS",
    defaultDays: 90,
    floorDays: 14,
    models: ["Waitlist"],
    anchor: "updatedAt",
    rationale:
      "Only entries that reached a terminal state (expired, cancelled, converted) are " +
      "swept; anything still active or notified is live state and is never touched by " +
      "age. Ninety days after a request died it tells the salon nothing it cannot read " +
      "off the appointment that did or did not follow.",
  },
  {
    key: "notificationLogs",
    category: "operational",
    action: "delete",
    envVar: "RETENTION_NOTIFICATION_LOG_DAYS",
    defaultDays: 180,
    floorDays: 30,
    models: ["NotificationLog"],
    anchor: "createdAt",
    rationale:
      "A delivery receipt holds the recipient address and the rendered message body. " +
      "Its value is deliverability debugging and 'did the reminder actually go out' for " +
      "a no-show fee argued shortly after the visit; both decay within months. Rows " +
      "still queued for delivery are excluded regardless of age — those are live work, " +
      "not history.",
  },
  {
    key: "callLogs",
    category: "operational",
    action: "delete",
    envVar: "RETENTION_CALL_LOG_DAYS",
    defaultDays: 365,
    floorDays: 30,
    models: ["CallLog"],
    anchor: "createdAt",
    rationale:
      "A voice-agent summary contains the caller's number and a paraphrase of what they " +
      "said. One year lets the salon review a season of the phone line and tune the " +
      "agent across the same period a year apart; beyond that it is a transcript of a " +
      "private conversation with no remaining purpose.",
  },
  {
    key: "conversations",
    category: "operational",
    action: "delete",
    envVar: "RETENTION_CONVERSATION_DAYS",
    defaultDays: 365,
    floorDays: 30,
    models: ["Conversation", "Message"],
    anchor: "createdAt (and the newest Message)",
    rationale:
      "Chat transcripts are the single richest personal-data store in the product — " +
      "people tell the booking agent about weddings, illnesses and other people. One " +
      "year matches the call logs so the two channels expire together. A thread is only " +
      "swept when its NEWEST message is also past the cutoff, so a long-running " +
      "WhatsApp conversation is never truncated from the front.",
  },
  {
    key: "dataRequests",
    category: "accountability",
    action: "delete",
    envVar: "RETENTION_DATA_REQUEST_DAYS",
    defaultDays: 365,
    floorDays: 90,
    models: ["DataRequest"],
    anchor: "createdAt",
    rationale:
      "Only `export` requests are swept. An erasure request is the proof under Art. " +
      "5(2) that the salon honoured an Art. 17 demand and its receipt is kept " +
      "indefinitely, as `gdpr-service.ts` promises on the receipt itself. A completed " +
      "export is a delivery record with no comparable evidential life.",
  },
  {
    key: "reviewRequests",
    category: "operational",
    action: "delete",
    envVar: "RETENTION_REVIEW_REQUEST_DAYS",
    defaultDays: 730,
    floorDays: 90,
    models: ["ReviewRequest"],
    anchor: "createdAt",
    rationale:
      "Not a free choice: `review-request-service.ts` suppresses a new ask for " +
      "DEFAULT_REVIEWED_COOLDOWN_DAYS (730) after a customer clicked one. Sweeping " +
      "earlier than that would make the salon ask a person who already reviewed them to " +
      "review them again, so the retention period is pinned to the cooldown.",
  },
  {
    key: "auditLogs",
    category: "accountability",
    action: "delete",
    envVar: "RETENTION_AUDIT_LOG_DAYS",
    defaultDays: 730,
    floorDays: 365,
    models: ["AuditLog"],
    anchor: "createdAt",
    rationale:
      "Two years is long enough to investigate an incident discovered late and to " +
      "reconstruct a disputed change from the season before last; it is also the figure " +
      "the erasure receipt in `gdpr-service.ts` already quotes to data subjects, so " +
      "moving it means correcting that promise too. Entries whose action starts with " +
      "'gdpr.' are never swept: they are the proof that an erasure was carried out.",
  },
  {
    key: "consentRecords",
    category: "consent",
    action: "delete",
    envVar: "RETENTION_CONSENT_DAYS",
    defaultDays: 1_825,
    floorDays: 730,
    models: ["ConsentRecord"],
    anchor: "the newest record of the type, once it is a withdrawal",
    rationale:
      "Consent proof is kept while the consent is live and for five years after it was " +
      "withdrawn. Art. 7(1) requires the controller to be able to demonstrate consent; " +
      "the window in which that demonstration can still be demanded is bounded by the " +
      "five-year prescription for administrative sanctions (L. 689/1981 art. 28). A " +
      "chain is only removed when the newest record for that customer and type is the " +
      "withdrawal, so re-granting consent restarts the clock for the whole chain.",
  },
  {
    key: "vouchers",
    category: "legal",
    action: "delete",
    envVar: "RETENTION_VOUCHER_DAYS",
    defaultDays: LEGAL_RETENTION_FLOOR_DAYS,
    floorDays: LEGAL_RETENTION_FLOOR_DAYS,
    models: ["Voucher"],
    anchor: "expiresAt",
    rationale:
      "Two independent guards. A voucher with a remaining balance is money the salon " +
      "owes and is NEVER swept, whatever its expiry says — an expiry the customer " +
      "disputes is a contract argument, and deleting the row would destroy the salon's " +
      "own side of it. A spent voucher can go, but removing it cascades its " +
      "VoucherRedemption rows, which are accounting movements, so the claims window is " +
      "the accounting floor and never shorter.",
  },
  {
    key: "appointments",
    category: "legal",
    action: "delete",
    envVar: "RETENTION_APPOINTMENTS_DAYS",
    defaultDays: LEGAL_RETENTION_FLOOR_DAYS,
    floorDays: LEGAL_RETENTION_FLOOR_DAYS,
    models: ["Appointment", "AppointmentStatusHistory", "Payment", "Refund"],
    anchor: "startsAt",
    rationale:
      "The appointment is the underlying business record of an invoiced service and " +
      "takes its status history, payments and refunds with it when it goes, so it may " +
      "not be removed one day before the accounting obligation ends. See " +
      "LEGAL_RETENTION_FLOOR_DAYS for why that is eleven years and not ten.",
  },
];

const RULES_BY_KEY = new Map<RetentionClassKey, RuleDefinition>(
  RULE_DEFINITIONS.map((rule) => [rule.key, rule]),
);

export const RETENTION_CLASS_KEYS: readonly RetentionClassKey[] = RULE_DEFINITIONS.map(
  (rule) => rule.key,
);

export type RetentionRule = {
  key: RetentionClassKey;
  category: RetentionCategory;
  action: RetentionAction;
  envVar: string;
  /** The period actually in force, after the floor has been applied. */
  days: number;
  defaultDays: number;
  floorDays: number;
  /** Set when the configured value was below the floor and the floor won. */
  clampedFromDays: number | null;
  models: string[];
  anchor: string;
  rationale: string;
};

export type RetentionPolicy = {
  timeZone: string;
  legalFloorDays: number;
  rules: RetentionRule[];
};

export type RetentionGuardReport = {
  requestedDays: number;
  enforcedDays: number;
};

export type ClassSweepReport = {
  dataClass: RetentionClassKey;
  category: RetentionCategory;
  action: RetentionAction;
  models: string[];
  retentionDays: number;
  cutoff: Date;
  cutoffSalonDay: string;
  /** Rows the rule looked at. */
  scanned: number;
  /** Rows removed. In a dry run, rows that WOULD be removed. */
  removed: number;
  /** Column redactions applied. In a dry run, the ones that WOULD be applied. */
  redacted: number;
  batches: number;
  /** The batch ceiling was reached; there is more to do on the next run. */
  moreRemaining: boolean;
  guard: RetentionGuardReport | null;
};

export type RetentionSweepError = {
  dataClass: RetentionClassKey;
  message: string;
};

export type RetentionSweepReport = {
  startedAt: Date;
  finishedAt: Date;
  dryRun: boolean;
  timeZone: string;
  batchSize: number;
  maxBatchesPerClass: number;
  removed: number;
  redacted: number;
  classes: ClassSweepReport[];
  errors: RetentionSweepError[];
  /** A class errored or hit its ceiling; the cron should come back sooner. */
  incomplete: boolean;
};

export type SweepOptions = {
  now?: Date;
  dryRun?: boolean;
  batchSize?: number;
  maxBatchesPerClass?: number;
  classes?: RetentionClassKey[];
  policy?: RetentionPolicy;
  recordAudit?: boolean;
};

const sweepOptionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
    batchSize: z.number().int().min(1).max(MAX_BATCH_SIZE).default(DEFAULT_BATCH_SIZE),
    maxBatchesPerClass: z
      .number()
      .int()
      .min(1)
      .max(MAX_BATCHES_PER_CLASS)
      .default(DEFAULT_MAX_BATCHES_PER_CLASS),
    recordAudit: z.boolean().default(true),
  })
  .strict();

function readRetentionDays(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
    throw new RetentionError(
      "RETENTION_PERIOD_INVALID",
      `Invalid ${name} "${raw}". Expected a whole number of days between 1 and ${MAX_RETENTION_DAYS}.`,
    );
  }
  return parsed;
}

/**
 * The policy in force. Read from the environment on every call rather than frozen at
 * import, so the owner can move a period with a redeploy and not a rebuild, and so a
 * misconfiguration is visible in the report the sweeper returns.
 */
export function retentionPolicy(
  env: Record<string, string | undefined> = process.env,
): RetentionPolicy {
  const rules = RULE_DEFINITIONS.map((definition) => {
    const configured = readRetentionDays(env, definition.envVar, definition.defaultDays);
    const days = Math.max(configured, definition.floorDays);
    if (days !== configured) {
      console.warn("[retention:clamped]", {
        dataClass: definition.key,
        envVar: definition.envVar,
        requestedDays: configured,
        enforcedDays: days,
      });
    }
    return {
      key: definition.key,
      category: definition.category,
      action: definition.action,
      envVar: definition.envVar,
      days,
      defaultDays: definition.defaultDays,
      floorDays: definition.floorDays,
      clampedFromDays: days === configured ? null : configured,
      models: [...definition.models],
      anchor: definition.anchor,
      rationale: definition.rationale,
    } satisfies RetentionRule;
  });
  return { timeZone: SALON_TIME_ZONE, legalFloorDays: LEGAL_RETENTION_FLOOR_DAYS, rules };
}

function shiftSalonDayKey(dayKey: string, deltaDays: number): string {
  const match = DAY_KEY_PATTERN.exec(dayKey);
  if (!match) {
    throw new RetentionError("RETENTION_DAY_KEY_INVALID", `Not a salon day key: "${dayKey}".`);
  }
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + deltaDays),
  );
  const year = String(shifted.getUTCFullYear()).padStart(4, "0");
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * First instant that is still inside the retention window: salon midnight `days` calendar
 * days before the salon day containing `now`. Anything strictly older may be swept.
 *
 * Calendar days, not fixed 24-hour blocks. On the two DST days of the year a salon day is
 * 23 or 25 hours long, and subtracting `days * 86_400_000` from `now` would put the
 * boundary an hour into a neighbouring day and at whatever time the cron happened to run.
 */
export function retentionCutoff(now: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 1) {
    throw new RetentionError(
      "RETENTION_PERIOD_INVALID",
      `Retention period must be a whole number of days >= 1, received ${String(days)}.`,
    );
  }
  return parseSalonDay(shiftSalonDayKey(salonDayKey(now), -days));
}

function retentionRedactedJson(): { redacted: string } {
  return { redacted: "retention" };
}

function isRedactedJson(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.redacted === "retention";
}

type StepResult = { scanned: number; changed: number; cursor: string | null };

const EXHAUSTED: StepResult = { scanned: 0, changed: 0, cursor: null };

/**
 * One bounded unit of work. `cursor` is a keyset position on `id`, which is what keeps a
 * dry run — where nothing disappears and so nothing shrinks the candidate set — from
 * looping on the same page forever. Returning a null cursor means the class is done.
 */
type SweepStep = (batchSize: number, cursor: string | null, dryRun: boolean) => Promise<StepResult>;

function pageEnd(rows: { id: string }[], batchSize: number): string | null {
  if (rows.length < batchSize) return null;
  return rows[rows.length - 1]?.id ?? null;
}

function idsOf(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

function after(cursor: string | null): { id: { gt: string } } | Record<string, never> {
  return cursor ? { id: { gt: cursor } } : {};
}

function stepsFor(key: RetentionClassKey, cutoff: Date): SweepStep[] {
  switch (key) {
    case "auditLogPayloads":
      return [
        async (batchSize, cursor, dryRun) => {
          const rows = await prisma.auditLog.findMany({
            where: {
              createdAt: { lt: cutoff },
              NOT: { action: { startsWith: GDPR_AUDIT_PREFIX } },
              ...after(cursor),
            },
            select: { id: true, ip: true, userAgent: true, before: true, after: true },
            orderBy: { id: "asc" },
            take: batchSize,
          });
          if (rows.length === 0) return EXHAUSTED;
          const identity = rows.filter((row) => row.ip !== null || row.userAgent !== null);
          const before = rows.filter(
            (row) => row.before !== null && !isRedactedJson(row.before),
          );
          const afterSnapshots = rows.filter(
            (row) => row.after !== null && !isRedactedJson(row.after),
          );
          let changed = identity.length + before.length + afterSnapshots.length;
          if (!dryRun) {
            changed = 0;
            if (identity.length > 0) {
              const updated = await prisma.auditLog.updateMany({
                where: { id: { in: idsOf(identity) } },
                data: { ip: null, userAgent: null },
              });
              changed += updated.count;
            }
            if (before.length > 0) {
              const updated = await prisma.auditLog.updateMany({
                where: { id: { in: idsOf(before) } },
                data: { before: retentionRedactedJson() },
              });
              changed += updated.count;
            }
            if (afterSnapshots.length > 0) {
              const updated = await prisma.auditLog.updateMany({
                where: { id: { in: idsOf(afterSnapshots) } },
                data: { after: retentionRedactedJson() },
              });
              changed += updated.count;
            }
          }
          return { scanned: rows.length, changed, cursor: pageEnd(rows, batchSize) };
        },
      ];

    case "appointmentFreeText":
      return [
        redactTextStep(
          async (batchSize, cursor) =>
            prisma.appointment.findMany({
              where: {
                startsAt: { lt: cutoff },
                notes: { not: null },
                NOT: { notes: RETENTION_REDACTION_MARKER },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (
              await prisma.appointment.updateMany({
                where: { id: { in: ids } },
                data: { notes: RETENTION_REDACTION_MARKER },
              })
            ).count,
        ),
        redactTextStep(
          async (batchSize, cursor) =>
            prisma.appointment.findMany({
              where: {
                startsAt: { lt: cutoff },
                cancellationReason: { not: null },
                NOT: { cancellationReason: RETENTION_REDACTION_MARKER },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (
              await prisma.appointment.updateMany({
                where: { id: { in: ids } },
                data: { cancellationReason: RETENTION_REDACTION_MARKER },
              })
            ).count,
        ),
      ];

    case "statusHistoryReasons":
      return [
        redactTextStep(
          async (batchSize, cursor) =>
            prisma.appointmentStatusHistory.findMany({
              where: {
                createdAt: { lt: cutoff },
                reason: { not: null },
                NOT: { reason: RETENTION_REDACTION_MARKER },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (
              await prisma.appointmentStatusHistory.updateMany({
                where: { id: { in: ids } },
                data: { reason: RETENTION_REDACTION_MARKER },
              })
            ).count,
        ),
      ];

    case "refundReasons":
      return [
        redactTextStep(
          async (batchSize, cursor) =>
            prisma.refund.findMany({
              where: {
                createdAt: { lt: cutoff },
                reason: { not: null },
                NOT: { reason: RETENTION_REDACTION_MARKER },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (
              await prisma.refund.updateMany({
                where: { id: { in: ids } },
                data: { reason: RETENTION_REDACTION_MARKER },
              })
            ).count,
        ),
      ];

    case "bookingVerifications":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.bookingVerification.findMany({
              where: { expiresAt: { lt: cutoff }, ...after(cursor) },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (await prisma.bookingVerification.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "waitlistEntries":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.waitlist.findMany({
              where: {
                status: { in: ["expired", "cancelled", "converted"] },
                updatedAt: { lt: cutoff },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) => (await prisma.waitlist.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "notificationLogs":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.notificationLog.findMany({
              where: {
                createdAt: { lt: cutoff },
                status: { in: ["sent", "failed", "abandoned"] },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (await prisma.notificationLog.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "callLogs":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.callLog.findMany({
              where: { createdAt: { lt: cutoff }, ...after(cursor) },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) => (await prisma.callLog.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "conversations":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.conversation.findMany({
              where: {
                createdAt: { lt: cutoff },
                messages: { none: { createdAt: { gte: cutoff } } },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (await prisma.conversation.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "dataRequests":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.dataRequest.findMany({
              where: { type: "export", createdAt: { lt: cutoff }, ...after(cursor) },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (await prisma.dataRequest.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "reviewRequests":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.reviewRequest.findMany({
              where: { createdAt: { lt: cutoff }, ...after(cursor) },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (await prisma.reviewRequest.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "auditLogs":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.auditLog.findMany({
              where: {
                createdAt: { lt: cutoff },
                NOT: { action: { startsWith: GDPR_AUDIT_PREFIX } },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) => (await prisma.auditLog.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "consentRecords":
      return [consentStep(cutoff)];

    case "vouchers":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.voucher.findMany({
              where: {
                expiresAt: { lt: cutoff },
                remainingCents: { lte: 0 },
                ...after(cursor),
              },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) => (await prisma.voucher.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];

    case "appointments":
      return [
        deleteStep(
          async (batchSize, cursor) =>
            prisma.appointment.findMany({
              where: { startsAt: { lt: cutoff }, ...after(cursor) },
              select: { id: true },
              orderBy: { id: "asc" },
              take: batchSize,
            }),
          async (ids) =>
            (await prisma.appointment.deleteMany({ where: { id: { in: ids } } })).count,
        ),
      ];
  }
}

function deleteStep(
  find: (batchSize: number, cursor: string | null) => Promise<{ id: string }[]>,
  remove: (ids: string[]) => Promise<number>,
): SweepStep {
  return async (batchSize, cursor, dryRun) => {
    const rows = await find(batchSize, cursor);
    if (rows.length === 0) return EXHAUSTED;
    const changed = dryRun ? rows.length : await remove(idsOf(rows));
    return { scanned: rows.length, changed, cursor: pageEnd(rows, batchSize) };
  };
}

function redactTextStep(
  find: (batchSize: number, cursor: string | null) => Promise<{ id: string }[]>,
  apply: (ids: string[]) => Promise<number>,
): SweepStep {
  return async (batchSize, cursor, dryRun) => {
    const rows = await find(batchSize, cursor);
    if (rows.length === 0) return EXHAUSTED;
    const changed = dryRun ? rows.length : await apply(idsOf(rows));
    return { scanned: rows.length, changed, cursor: pageEnd(rows, batchSize) };
  };
}

/**
 * A consent chain leaves as a unit or not at all.
 *
 * The candidate is a withdrawal older than the proof window. It only counts if it is
 * still the NEWEST record for that customer and type — if the person opted back in
 * afterwards, the withdrawal is part of a live history and the whole chain stays, because
 * proving today's consent means being able to show what came before it.
 */
function consentStep(cutoff: Date): SweepStep {
  return async (batchSize, cursor, dryRun) => {
    const withdrawals = await prisma.consentRecord.findMany({
      where: { granted: false, createdAt: { lt: cutoff }, ...after(cursor) },
      select: { id: true, customerId: true, type: true, createdAt: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (withdrawals.length === 0) return EXHAUSTED;

    let changed = 0;
    for (const withdrawal of withdrawals) {
      const scope = { customerId: withdrawal.customerId, type: withdrawal.type };
      const newer = await prisma.consentRecord.count({
        where: { ...scope, createdAt: { gt: withdrawal.createdAt } },
      });
      if (newer > 0) continue;
      const chain = { ...scope, createdAt: { lte: withdrawal.createdAt } };
      changed += dryRun
        ? await prisma.consentRecord.count({ where: chain })
        : (await prisma.consentRecord.deleteMany({ where: chain })).count;
    }
    return { scanned: withdrawals.length, changed, cursor: pageEnd(withdrawals, batchSize) };
  };
}

function toAuditSummary(report: RetentionSweepReport): Prisma.InputJsonValue {
  return {
    startedAt: report.startedAt.toISOString(),
    finishedAt: report.finishedAt.toISOString(),
    timeZone: report.timeZone,
    batchSize: report.batchSize,
    removed: report.removed,
    redacted: report.redacted,
    incomplete: report.incomplete,
    classes: report.classes.map((entry) => ({
      dataClass: entry.dataClass,
      retentionDays: entry.retentionDays,
      cutoffSalonDay: entry.cutoffSalonDay,
      removed: entry.removed,
      redacted: entry.redacted,
      moreRemaining: entry.moreRemaining,
    })),
    errors: report.errors.map((entry) => ({
      dataClass: entry.dataClass,
      message: entry.message,
    })),
  };
}

export class DataRetentionService {
  /** The periods currently in force, floors applied. Safe to show the owner. */
  policy(env: Record<string, string | undefined> = process.env): RetentionPolicy {
    return retentionPolicy(env);
  }

  /**
   * The sweeper the cron endpoint calls.
   *
   * Every class is bounded twice: `batchSize` rows per statement so no single DELETE
   * takes a wide lock, and `maxBatchesPerClass` statements per class so one enormous
   * backlog cannot starve the classes queued behind it or hold a connection for minutes.
   * A class that hits its ceiling reports `moreRemaining` and the run reports
   * `incomplete`; the next tick picks up where it left off.
   *
   * One class failing is not the run failing. A malformed row or a lock timeout in the
   * conversations sweep must not stop the audit payloads from being redacted, so every
   * class is isolated and its error is reported rather than thrown.
   */
  async sweep(options: SweepOptions = {}): Promise<RetentionSweepReport> {
    const parsed = sweepOptionsSchema.parse({
      dryRun: options.dryRun,
      batchSize: options.batchSize,
      maxBatchesPerClass: options.maxBatchesPerClass,
      recordAudit: options.recordAudit,
    });
    const startedAt = options.now ?? new Date();
    const policy = options.policy ?? retentionPolicy();
    const requested = options.classes;
    if (requested) {
      for (const key of requested) {
        if (!RULES_BY_KEY.has(key)) {
          throw new RetentionError("RETENTION_CLASS_UNKNOWN", `Unknown data class "${key}".`);
        }
      }
    }
    const selected = new Set<RetentionClassKey>(requested ?? RETENTION_CLASS_KEYS);
    const configured = new Map(policy.rules.map((rule) => [rule.key, rule]));

    const classes: ClassSweepReport[] = [];
    const errors: RetentionSweepError[] = [];

    for (const definition of RULE_DEFINITIONS) {
      if (!selected.has(definition.key)) continue;
      const rule = configured.get(definition.key);
      const configuredDays = rule?.days ?? definition.defaultDays;
      // What the operator actually asked for, whether the policy already clamped it or
      // handed the sweeper a short period directly. Both must be visible in the report.
      const requestedDays = rule?.clampedFromDays ?? configuredDays;

      // The guard. `definition.floorDays` is read from this module's own table, never
      // from the policy object that was handed in, so neither a misconfigured
      // environment variable nor a hand-built policy can shorten a legal window.
      const days = Math.max(configuredDays, definition.floorDays);
      const cutoff = retentionCutoff(startedAt, days);

      const entry: ClassSweepReport = {
        dataClass: definition.key,
        category: definition.category,
        action: definition.action,
        models: [...definition.models],
        retentionDays: days,
        cutoff,
        cutoffSalonDay: salonDayKey(cutoff),
        scanned: 0,
        removed: 0,
        redacted: 0,
        batches: 0,
        moreRemaining: false,
        guard: days === requestedDays ? null : { requestedDays, enforcedDays: days },
      };
      classes.push(entry);

      try {
        for (const step of stepsFor(definition.key, cutoff)) {
          let cursor: string | null = null;
          for (;;) {
            if (entry.batches >= parsed.maxBatchesPerClass) {
              entry.moreRemaining = true;
              break;
            }
            const result: StepResult = await step(parsed.batchSize, cursor, parsed.dryRun);
            if (result.scanned === 0) break;
            entry.batches += 1;
            entry.scanned += result.scanned;
            if (definition.action === "delete") entry.removed += result.changed;
            else entry.redacted += result.changed;
            if (result.cursor === null) break;
            cursor = result.cursor;
          }
          if (entry.moreRemaining) break;
        }
      } catch (error) {
        errors.push({
          dataClass: definition.key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const report: RetentionSweepReport = {
      startedAt,
      finishedAt: options.now ?? new Date(),
      dryRun: parsed.dryRun,
      timeZone: SALON_TIME_ZONE,
      batchSize: parsed.batchSize,
      maxBatchesPerClass: parsed.maxBatchesPerClass,
      removed: classes.reduce((sum, entry) => sum + entry.removed, 0),
      redacted: classes.reduce((sum, entry) => sum + entry.redacted, 0),
      classes,
      errors,
      incomplete: errors.length > 0 || classes.some((entry) => entry.moreRemaining),
    };

    if (parsed.recordAudit && !parsed.dryRun) {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          actorEmail: RETENTION_ACTOR_EMAIL,
          actorRole: "system",
          action: RETENTION_AUDIT_ACTION,
          entityType: "system",
          entityId: "data-retention",
          after: toAuditSummary(report),
        },
      });
    }

    return report;
  }

  /**
   * What the sweeper WOULD remove, having changed nothing. This is the call the owner
   * makes before moving a period: it walks exactly the same predicates as the real run,
   * so the numbers it reports are the numbers that would be destroyed.
   */
  async previewSweep(options: Omit<SweepOptions, "dryRun"> = {}): Promise<RetentionSweepReport> {
    return this.sweep({ ...options, dryRun: true });
  }
}

export const dataRetentionService = new DataRetentionService();

// A retention period that cannot be parsed must stop the process at boot, not silently at
// 03:00 when the cron fires against a production database.
retentionPolicy();
