import { z } from "zod";
import { prisma } from "@hair-simo/db";
import { getServiceTranslationName, resolveLocale } from "@hair-simo/i18n";
import type { AppointmentStatus, CustomerNoteKind } from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";
import { formatInSalonZone, formatSalonTimeRange } from "./time";

const MS_PER_DAY = 86_400_000;

/**
 * How far back the "what did we do to this hair" view reaches. Two years covers a
 * colour client's full history of formulas and grow-out cycles; older visits stay in
 * the database and still count towards lifetime value, they just stop crowding the
 * card the stylist reads in the thirty seconds before the customer sits down.
 */
export const CUSTOMER_HISTORY_WINDOW_MONTHS = 24;

/** Hard ceilings so one pathological customer cannot turn the profile into a full scan. */
export const MAX_HISTORY_APPOINTMENTS = 500;
export const MAX_PROFILE_NOTES = 50;
export const MAX_RECENT_VISITS = 20;
export const MAX_FORMULA_HISTORY = 10;

/**
 * Version marker of the JSON envelope a colour formula is stored in. Bump it when the
 * shape changes; readers keep understanding every older version.
 */
export const FORMULA_NOTE_VERSION = 1;

const noteTextSchema = z.string().trim().min(1).max(4_000);

const formulaSchema = z
  .object({
    product: z.string().trim().min(1).max(200),
    developer: z.string().trim().max(100).optional(),
    ratio: z.string().trim().max(50).optional(),
    processingMinutes: z.number().int().min(1).max(240).optional(),
    result: z.string().trim().max(1_000).optional(),
    appointmentId: z.string().trim().min(1).max(50).optional(),
    appliedAt: z.union([z.date(), z.string().datetime()]).optional(),
  })
  .strict();

export type FormulaInput = z.input<typeof formulaSchema>;

export type HistoryActor = {
  userId?: string;
  email?: string;
  role?: string;
};

export type CustomerNoteView = {
  id: string;
  customerId: string;
  kind: CustomerNoteKind;
  /** Display text. For formula notes this is the rendered summary, never the raw JSON. */
  text: string;
  /** Exactly what is stored in the column, for editors and for round-tripping. */
  raw: string;
  pinned: boolean;
  authorId: string | null;
  createdAt: Date;
  createdAtLabel: string;
  updatedAt: Date;
};

export type FormulaRecord = {
  noteId: string;
  customerId: string;
  version: number;
  product: string;
  developer: string | null;
  ratio: string | null;
  processingMinutes: number | null;
  result: string | null;
  appointmentId: string | null;
  authorId: string | null;
  pinned: boolean;
  summary: string;
  /** `appliedAt` when the stylist backdated it, otherwise when the note was written. */
  recordedAt: Date;
  recordedAtLabel: string;
};

export type VisitSummary = {
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  timeLabel: string;
  status: AppointmentStatus;
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  priceCents: number;
  paidCents: number;
  notes: string | null;
};

export type PreferredStaff = {
  staffId: string;
  displayName: string;
  visits: number;
  /** Share of the visits in the window, 0..1. Below ~0.6 the customer has no favourite. */
  share: number;
  lastVisitAt: Date;
};

export type PreferredService = {
  serviceId: string;
  slug: string;
  name: string;
  visits: number;
  share: number;
};

export type CustomerStats = {
  visitCount: number;
  upcomingCount: number;
  cancelledCount: number;
  noShowCount: number;
  noShowRate: number;
  /**
   * Till value of every completed visit at the current list price, plus tips actually
   * collected. The salon takes most of its money in cash at the counter and only a
   * deposit online, so `paidOnlineCents` alone would understate a good customer by
   * roughly 70%. Historic price changes are not reconstructable — see openIssues.
   */
  lifetimeValueCents: number;
  paidOnlineCents: number;
  tipsCents: number;
  currency: "EUR";
  averageIntervalDays: number | null;
  daysSinceLastVisit: number | null;
  /** Past the usual rhythm with nothing in the book: the rebooking nudge list. */
  dueForRebooking: boolean;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  lastVisitLabel: string | null;
  nextAppointmentAt: Date | null;
  nextAppointmentLabel: string | null;
};

export type CustomerSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  locale: AppLocale;
  marketingOptIn: boolean;
  customerSince: Date;
  customerSinceLabel: string;
};

export type CustomerProfile = {
  customer: CustomerSummary;
  hasAllergies: boolean;
  allergies: CustomerNoteView[];
  pinned: CustomerNoteView[];
  notes: CustomerNoteView[];
  noteCounts: Record<CustomerNoteKind, number> & { total: number };
  latestFormula: FormulaRecord | null;
  formulaHistory: FormulaRecord[];
  preferredStaff: PreferredStaff | null;
  preferredService: PreferredService | null;
  stats: CustomerStats;
  lastVisit: VisitSummary | null;
  nextAppointment: VisitSummary | null;
  recentVisits: VisitSummary[];
  windowMonths: number;
  generatedAt: Date;
};

type NoteRow = {
  id: string;
  customerId: string;
  note: string;
  kind: CustomerNoteKind;
  authorId: string | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type AppointmentRow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  notes: string | null;
  serviceId: string;
  staffId: string | null;
  service: {
    slug: string;
    priceCents: number;
    translations: { locale: string; name: string }[];
  };
  staff: { id: string; displayName: string } | null;
  payments: { amountCents: number; tipCents: number; refundedCents: number; status: string }[];
};

type FormulaPayload = {
  v: number;
  product: string;
  developer?: string;
  ratio?: string;
  processingMinutes?: number;
  result?: string;
  appointmentId?: string;
  appliedAt?: string;
  text: string;
};

/**
 * Month arithmetic on the UTC fields, never on the host-local ones: `setMonth` would
 * resolve in the server's zone and shift the window by an hour across a DST boundary.
 * The window edge only bounds a list, so UTC month arithmetic is precise enough while
 * staying free of the salon-zone conversion `time.ts` owns.
 */
function monthsBefore(instant: Date, months: number): Date {
  const shifted = new Date(instant.getTime());
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  return shifted;
}

function dayLabel(instant: Date, locale: string): string {
  return formatInSalonZone(instant, locale, { dateStyle: "medium", timeStyle: "short" });
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

function renderFormulaSummary(input: {
  product: string;
  developer?: string;
  ratio?: string;
  processingMinutes?: number;
  result?: string;
}): string {
  const parts: string[] = [input.product];
  if (!isBlank(input.developer)) parts.push(String(input.developer));
  if (!isBlank(input.ratio)) parts.push(String(input.ratio));
  if (input.processingMinutes) parts.push(`${input.processingMinutes} min`);
  if (!isBlank(input.result)) parts.push(String(input.result));
  return parts.join(" | ");
}

/**
 * Serialise a formula into the `CustomerNote.note` text column.
 *
 * The tradeoff, deliberately taken: the platform gets structured, queryable formulas
 * with no migration and no new table. `note` holds a single JSON object and nothing
 * else, so Postgres can already answer `WHERE kind = 'formula' AND note::jsonb->>
 * 'product' ILIKE '%Igora 6-46%'`, and promoting it to a real `jsonb payload` column
 * later is a one-line `UPDATE ... SET payload = note::jsonb` with no parsing step.
 * The cost is that the column is not indexable as JSON today (a GIN index would need
 * the migration this avoids) and that any writer bypassing this service can put
 * non-JSON in a formula note — which is why {@link parseFormulaNote} degrades to a
 * plain-text formula instead of throwing. `text` is regenerated on every write from
 * the structured fields, so a reader that does not parse JSON still has something
 * printable and it can never drift from the parts it summarises.
 */
export function serializeFormula(input: FormulaInput): string {
  const parsed = formulaSchema.parse(input);
  const appliedAt = parsed.appliedAt ? new Date(parsed.appliedAt) : undefined;
  if (appliedAt && Number.isNaN(appliedAt.getTime())) throw new Error("INVALID_APPLIED_AT");
  const payload: FormulaPayload = {
    v: FORMULA_NOTE_VERSION,
    product: parsed.product,
    ...(isBlank(parsed.developer) ? {} : { developer: parsed.developer }),
    ...(isBlank(parsed.ratio) ? {} : { ratio: parsed.ratio }),
    ...(parsed.processingMinutes ? { processingMinutes: parsed.processingMinutes } : {}),
    ...(isBlank(parsed.result) ? {} : { result: parsed.result }),
    ...(parsed.appointmentId ? { appointmentId: parsed.appointmentId } : {}),
    ...(appliedAt ? { appliedAt: appliedAt.toISOString() } : {}),
    text: renderFormulaSummary({
      product: parsed.product,
      developer: parsed.developer,
      ratio: parsed.ratio,
      processingMinutes: parsed.processingMinutes,
      result: parsed.result,
    }),
  };
  return JSON.stringify(payload);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Read a formula note back. A note that is not JSON — hand-typed before this service
 * existed, or written by a later import — still yields a usable record with the raw
 * text as the product, because losing a colour formula is worse than losing structure.
 */
export function parseFormulaNote(note: NoteRow, locale: string): FormulaRecord | null {
  if (note.kind !== "formula") return null;
  const trimmed = note.note.trim();
  const base = {
    noteId: note.id,
    customerId: note.customerId,
    authorId: note.authorId,
    pinned: note.pinned,
  };

  if (trimmed.startsWith("{")) {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
        const source = decoded as Record<string, unknown>;
        const product = readString(source, "product");
        if (product) {
          const rawApplied = readString(source, "appliedAt");
          const applied = rawApplied ? new Date(rawApplied) : null;
          const recordedAt =
            applied && !Number.isNaN(applied.getTime()) ? applied : note.createdAt;
          const processing = source.processingMinutes;
          const developer = readString(source, "developer");
          const ratio = readString(source, "ratio");
          const result = readString(source, "result");
          const processingMinutes =
            typeof processing === "number" && Number.isFinite(processing) ? processing : null;
          return {
            ...base,
            version: typeof source.v === "number" ? source.v : 0,
            product,
            developer,
            ratio,
            processingMinutes,
            result,
            appointmentId: readString(source, "appointmentId"),
            summary:
              readString(source, "text") ??
              renderFormulaSummary({
                product,
                developer: developer ?? undefined,
                ratio: ratio ?? undefined,
                processingMinutes: processingMinutes ?? undefined,
                result: result ?? undefined,
              }),
            recordedAt,
            recordedAtLabel: dayLabel(recordedAt, locale),
          };
        }
      }
    } catch {
      // Falls through to the plain-text reading below.
    }
  }

  return {
    ...base,
    version: 0,
    product: trimmed,
    developer: null,
    ratio: null,
    processingMinutes: null,
    result: null,
    appointmentId: null,
    summary: trimmed,
    recordedAt: note.createdAt,
    recordedAtLabel: dayLabel(note.createdAt, locale),
  };
}

function toNoteView(note: NoteRow, locale: string): CustomerNoteView {
  const formula = parseFormulaNote(note, locale);
  return {
    id: note.id,
    customerId: note.customerId,
    kind: note.kind,
    text: formula ? formula.summary : note.note,
    raw: note.note,
    pinned: note.pinned,
    authorId: note.authorId,
    createdAt: note.createdAt,
    createdAtLabel: dayLabel(note.createdAt, locale),
    updatedAt: note.updatedAt,
  };
}

function paidCentsOf(payments: AppointmentRow["payments"]): number {
  return payments
    .filter((payment) => payment.status === "paid")
    .reduce(
      (sum, payment) =>
        sum + payment.amountCents + payment.tipCents - payment.refundedCents,
      0,
    );
}

function tipsCentsOf(payments: AppointmentRow["payments"]): number {
  return payments
    .filter((payment) => payment.status === "paid")
    .reduce((sum, payment) => sum + payment.tipCents, 0);
}

function toVisitSummary(appointment: AppointmentRow, locale: AppLocale): VisitSummary {
  return {
    appointmentId: appointment.id,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timeLabel: formatSalonTimeRange(appointment.startsAt, appointment.endsAt, locale),
    status: appointment.status,
    serviceId: appointment.serviceId,
    serviceSlug: appointment.service.slug,
    serviceName: getServiceTranslationName(
      appointment.service.translations,
      locale,
      appointment.service.slug,
    ),
    staffId: appointment.staffId,
    staffName: appointment.staff?.displayName ?? null,
    priceCents: appointment.service.priceCents,
    paidCents: paidCentsOf(appointment.payments),
    notes: appointment.notes,
  };
}

function averageIntervalDays(visitsAscending: AppointmentRow[]): number | null {
  if (visitsAscending.length < 2) return null;
  let total = 0;
  for (let index = 1; index < visitsAscending.length; index += 1) {
    total += visitsAscending[index].startsAt.getTime() - visitsAscending[index - 1].startsAt.getTime();
  }
  const meanMs = total / (visitsAscending.length - 1);
  return Math.round((meanMs / MS_PER_DAY) * 10) / 10;
}

/**
 * The preferred stylist is derived, never stored: what a customer books is a better
 * signal than what someone once ticked in a form, and it self-corrects when a stylist
 * leaves. Ties go to whoever the customer saw most recently.
 */
function derivePreferredStaff(visits: AppointmentRow[]): PreferredStaff | null {
  const byStaff = new Map<string, { displayName: string; visits: number; lastVisitAt: Date }>();
  let assigned = 0;
  for (const visit of visits) {
    if (!visit.staffId) continue;
    assigned += 1;
    const current = byStaff.get(visit.staffId);
    if (current) {
      current.visits += 1;
      if (visit.startsAt > current.lastVisitAt) current.lastVisitAt = visit.startsAt;
      continue;
    }
    byStaff.set(visit.staffId, {
      displayName: visit.staff?.displayName ?? visit.staffId,
      visits: 1,
      lastVisitAt: visit.startsAt,
    });
  }
  if (assigned === 0) return null;

  let best: PreferredStaff | null = null;
  for (const [staffId, entry] of byStaff) {
    const candidate: PreferredStaff = {
      staffId,
      displayName: entry.displayName,
      visits: entry.visits,
      share: Math.round((entry.visits / assigned) * 100) / 100,
      lastVisitAt: entry.lastVisitAt,
    };
    if (
      !best ||
      candidate.visits > best.visits ||
      (candidate.visits === best.visits && candidate.lastVisitAt > best.lastVisitAt)
    ) {
      best = candidate;
    }
  }
  return best;
}

function derivePreferredService(
  visits: AppointmentRow[],
  locale: AppLocale,
): PreferredService | null {
  if (visits.length === 0) return null;
  const byService = new Map<string, { slug: string; name: string; visits: number; lastAt: Date }>();
  for (const visit of visits) {
    const current = byService.get(visit.serviceId);
    if (current) {
      current.visits += 1;
      if (visit.startsAt > current.lastAt) current.lastAt = visit.startsAt;
      continue;
    }
    byService.set(visit.serviceId, {
      slug: visit.service.slug,
      name: getServiceTranslationName(visit.service.translations, locale, visit.service.slug),
      visits: 1,
      lastAt: visit.startsAt,
    });
  }

  let bestId: string | null = null;
  let bestVisits = 0;
  let bestLastAt = new Date(0);
  for (const [serviceId, entry] of byService) {
    if (entry.visits > bestVisits || (entry.visits === bestVisits && entry.lastAt > bestLastAt)) {
      bestId = serviceId;
      bestVisits = entry.visits;
      bestLastAt = entry.lastAt;
    }
  }
  if (!bestId) return null;
  const best = byService.get(bestId);
  if (!best) return null;
  return {
    serviceId: bestId,
    slug: best.slug,
    name: best.name,
    visits: best.visits,
    share: Math.round((best.visits / visits.length) * 100) / 100,
  };
}

async function loadWritableCustomer(customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null, anonymizedAt: null },
    select: { id: true, locale: true },
  });
  if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
  return customer;
}

type AuditPayload = Record<string, string | number | boolean | null>;

async function writeAudit(input: {
  action: string;
  entityId: string;
  actor?: HistoryActor;
  before?: AuditPayload;
  after?: AuditPayload;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: input.actor?.userId ?? null,
      actorEmail: input.actor?.email ?? "system@hair-simo",
      actorRole: input.actor?.role ?? "system",
      action: input.action,
      entityType: "CustomerNote",
      entityId: input.entityId,
      before: input.before ?? undefined,
      after: input.after ?? undefined,
    },
  });
}

export class CustomerHistoryService {
  /**
   * Everything the stylist needs before the customer sits down, in one call and three
   * queries. Allergies are surfaced separately from the pinning mechanism on purpose:
   * a colleague who forgets to pin an allergy note must not be able to hide it.
   */
  async getCustomerProfile(
    customerId: string,
    options?: { locale?: AppLocale; historyMonths?: number; now?: Date },
  ): Promise<CustomerProfile> {
    const now = options?.now ?? new Date();
    const windowMonths = Math.max(1, Math.min(120, options?.historyMonths ?? CUSTOMER_HISTORY_WINDOW_MONTHS));

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null, anonymizedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        locale: true,
        marketingOptIn: true,
        createdAt: true,
      },
    });
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");

    const locale = options?.locale ?? resolveLocale(customer.locale);

    const [noteRows, appointmentRows] = await Promise.all([
      prisma.customerNote.findMany({
        where: { customerId },
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      }),
      prisma.appointment.findMany({
        where: { customerId },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          notes: true,
          serviceId: true,
          staffId: true,
          service: {
            select: {
              slug: true,
              priceCents: true,
              translations: { select: { locale: true, name: true } },
            },
          },
          staff: { select: { id: true, displayName: true } },
          payments: {
            select: {
              amountCents: true,
              tipCents: true,
              refundedCents: true,
              status: true,
            },
          },
        },
        orderBy: { startsAt: "desc" },
        take: MAX_HISTORY_APPOINTMENTS,
      }),
    ]);

    const notes: NoteRow[] = noteRows as NoteRow[];
    const appointments: AppointmentRow[] = appointmentRows as AppointmentRow[];

    const noteCounts = {
      total: notes.length,
      general: 0,
      formula: 0,
      allergy: 0,
      preference: 0,
    };
    for (const note of notes) noteCounts[note.kind] += 1;

    const allergies = notes
      .filter((note) => note.kind === "allergy")
      .map((note) => toNoteView(note, locale));
    const pinned = notes
      .filter((note) => note.pinned && note.kind !== "allergy")
      .map((note) => toNoteView(note, locale));
    const rest = notes
      .filter((note) => !note.pinned && note.kind !== "allergy")
      .slice(0, MAX_PROFILE_NOTES)
      .map((note) => toNoteView(note, locale));

    const formulaHistory = notes
      .flatMap((note) => {
        const record = parseFormulaNote(note, locale);
        return record ? [record] : [];
      })
      .sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime())
      .slice(0, MAX_FORMULA_HISTORY);

    const windowStart = monthsBefore(now, windowMonths);
    const completed = appointments.filter((entry) => entry.status === "completed");
    const completedAscending = [...completed].sort(
      (left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
    );
    const completedInWindow = completed.filter((entry) => entry.startsAt >= windowStart);
    const upcoming = appointments
      .filter(
        (entry) =>
          entry.startsAt > now && (entry.status === "pending" || entry.status === "confirmed"),
      )
      .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());

    const lastVisitRow = completedAscending.at(-1) ?? null;
    const nextAppointmentRow = upcoming[0] ?? null;

    const paidOnlineCents = appointments.reduce(
      (sum, entry) => sum + paidCentsOf(entry.payments),
      0,
    );
    const tipsCents = appointments.reduce((sum, entry) => sum + tipsCentsOf(entry.payments), 0);
    const servicesValueCents = completed.reduce(
      (sum, entry) => sum + entry.service.priceCents,
      0,
    );

    const noShowCount = appointments.filter((entry) => entry.status === "no_show").length;
    const cancelledCount = appointments.filter((entry) => entry.status === "cancelled").length;
    const attended = completed.length + noShowCount;
    const interval = averageIntervalDays(completedAscending);
    const daysSinceLastVisit = lastVisitRow
      ? Math.floor((now.getTime() - lastVisitRow.startsAt.getTime()) / MS_PER_DAY)
      : null;

    const stats: CustomerStats = {
      visitCount: completed.length,
      upcomingCount: upcoming.length,
      cancelledCount,
      noShowCount,
      noShowRate: attended === 0 ? 0 : Math.round((noShowCount / attended) * 100) / 100,
      lifetimeValueCents: servicesValueCents + tipsCents,
      paidOnlineCents,
      tipsCents,
      currency: "EUR",
      averageIntervalDays: interval,
      daysSinceLastVisit,
      dueForRebooking:
        interval !== null &&
        daysSinceLastVisit !== null &&
        daysSinceLastVisit > interval * 1.15 &&
        upcoming.length === 0,
      firstVisitAt: completedAscending[0]?.startsAt ?? null,
      lastVisitAt: lastVisitRow?.startsAt ?? null,
      lastVisitLabel: lastVisitRow ? dayLabel(lastVisitRow.startsAt, locale) : null,
      nextAppointmentAt: nextAppointmentRow?.startsAt ?? null,
      nextAppointmentLabel: nextAppointmentRow
        ? dayLabel(nextAppointmentRow.startsAt, locale)
        : null,
    };

    return {
      customer: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        locale,
        marketingOptIn: customer.marketingOptIn,
        customerSince: customer.createdAt,
        customerSinceLabel: dayLabel(customer.createdAt, locale),
      },
      hasAllergies: allergies.length > 0,
      allergies,
      pinned,
      notes: rest,
      noteCounts,
      latestFormula: formulaHistory[0] ?? null,
      formulaHistory,
      preferredStaff: derivePreferredStaff(completedInWindow),
      preferredService: derivePreferredService(completedInWindow, locale),
      stats,
      lastVisit: lastVisitRow ? toVisitSummary(lastVisitRow, locale) : null,
      nextAppointment: nextAppointmentRow ? toVisitSummary(nextAppointmentRow, locale) : null,
      recentVisits: appointments
        .filter(
          (entry) =>
            entry.startsAt >= windowStart &&
            (entry.status === "completed" || entry.status === "no_show"),
        )
        .slice(0, MAX_RECENT_VISITS)
        .map((entry) => toVisitSummary(entry, locale)),
      windowMonths,
      generatedAt: now,
    };
  }

  async listNotes(
    customerId: string,
    options?: { kind?: CustomerNoteKind; locale?: AppLocale; take?: number; skip?: number },
  ): Promise<CustomerNoteView[]> {
    const locale = options?.locale ?? "de";
    const rows = await prisma.customerNote.findMany({
      where: { customerId, ...(options?.kind ? { kind: options.kind } : {}) },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      skip: Math.max(0, options?.skip ?? 0),
      take: Math.min(200, Math.max(1, options?.take ?? MAX_PROFILE_NOTES)),
    });
    return (rows as NoteRow[]).map((row) => toNoteView(row, locale));
  }

  /**
   * An allergy note is always pinned, whatever the caller asked for. It is the one kind
   * of note whose absence from the top of the card can burn a scalp.
   */
  async addNote(input: {
    customerId: string;
    note: string;
    kind?: CustomerNoteKind;
    pinned?: boolean;
    actor?: HistoryActor;
  }): Promise<CustomerNoteView> {
    await loadWritableCustomer(input.customerId);
    const text = noteTextSchema.parse(input.note);
    const kind = input.kind ?? "general";
    const pinned = kind === "allergy" ? true : (input.pinned ?? false);

    const created = (await prisma.customerNote.create({
      data: {
        customerId: input.customerId,
        note: text,
        kind,
        pinned,
        authorId: input.actor?.userId ?? null,
      },
    })) as NoteRow;

    if (kind === "allergy") {
      await writeAudit({
        action: "customer.note.allergy.created",
        entityId: created.id,
        actor: input.actor,
        after: { customerId: input.customerId, note: text },
      });
    }
    return toNoteView(created, "de");
  }

  async updateNote(
    noteId: string,
    patch: { note?: string; pinned?: boolean },
    options?: { actor?: HistoryActor },
  ): Promise<CustomerNoteView> {
    const existing = (await prisma.customerNote.findUnique({
      where: { id: noteId },
      include: { customer: { select: { deletedAt: true, anonymizedAt: true } } },
    })) as (NoteRow & { customer: { deletedAt: Date | null; anonymizedAt: Date | null } }) | null;
    if (!existing) throw new Error("NOTE_NOT_FOUND");
    if (existing.customer.deletedAt || existing.customer.anonymizedAt) {
      throw new Error("CUSTOMER_NOT_FOUND");
    }
    if (existing.kind === "allergy" && patch.pinned === false) {
      throw new Error("ALLERGY_NOTE_MUST_STAY_PINNED");
    }

    const text = patch.note === undefined ? undefined : noteTextSchema.parse(patch.note);
    const updated = (await prisma.customerNote.update({
      where: { id: noteId },
      data: {
        ...(text === undefined ? {} : { note: text }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      },
    })) as NoteRow;

    if (existing.kind === "allergy") {
      await writeAudit({
        action: "customer.note.allergy.updated",
        entityId: noteId,
        actor: options?.actor,
        before: { note: existing.note, pinned: existing.pinned },
        after: { note: updated.note, pinned: updated.pinned },
      });
    }
    return toNoteView(updated, "de");
  }

  async pinNote(
    noteId: string,
    pinned: boolean,
    options?: { actor?: HistoryActor },
  ): Promise<CustomerNoteView> {
    return this.updateNote(noteId, { pinned }, options);
  }

  /**
   * Deleting an allergy note takes a second, explicit confirmation and is always
   * audited. Everything else about this platform can be reconstructed; a forgotten
   * allergy cannot.
   */
  async deleteNote(
    noteId: string,
    options?: { actor?: HistoryActor; confirmAllergyDeletion?: boolean },
  ): Promise<{ id: string; kind: CustomerNoteKind }> {
    const existing = (await prisma.customerNote.findUnique({
      where: { id: noteId },
    })) as NoteRow | null;
    if (!existing) throw new Error("NOTE_NOT_FOUND");
    if (existing.kind === "allergy" && options?.confirmAllergyDeletion !== true) {
      throw new Error("ALLERGY_NOTE_DELETE_NOT_CONFIRMED");
    }

    await prisma.customerNote.delete({ where: { id: noteId } });
    await writeAudit({
      action:
        existing.kind === "allergy" ? "customer.note.allergy.deleted" : "customer.note.deleted",
      entityId: noteId,
      actor: options?.actor,
      before: {
        customerId: existing.customerId,
        kind: existing.kind,
        note: existing.note,
        pinned: existing.pinned,
      },
    });
    return { id: existing.id, kind: existing.kind };
  }

  /**
   * First-class because it is the single most retrieved fact in a colour salon: what
   * did we mix last time. Stored as a formula-kind note carrying a JSON envelope, see
   * {@link serializeFormula} for the tradeoff.
   */
  async recordFormula(
    customerId: string,
    formula: FormulaInput,
    options?: { actor?: HistoryActor; pinned?: boolean; locale?: AppLocale },
  ): Promise<FormulaRecord> {
    const customer = await loadWritableCustomer(customerId);
    const locale = options?.locale ?? resolveLocale(customer.locale);
    const note = serializeFormula(formula);

    const created = (await prisma.customerNote.create({
      data: {
        customerId,
        note,
        kind: "formula",
        pinned: options?.pinned ?? false,
        authorId: options?.actor?.userId ?? null,
      },
    })) as NoteRow;

    const record = parseFormulaNote(created, locale);
    if (!record) throw new Error("FORMULA_NOT_STORED");
    return record;
  }

  async getLatestFormula(
    customerId: string,
    options?: { locale?: AppLocale },
  ): Promise<FormulaRecord | null> {
    const records = await this.listFormulas(customerId, { ...options, take: MAX_FORMULA_HISTORY });
    return records[0] ?? null;
  }

  /**
   * Newest first by the date the colour was actually applied, which is not always the
   * date the note was typed — a stylist entering yesterday's formula must not push it
   * ahead of one recorded today.
   */
  async listFormulas(
    customerId: string,
    options?: { locale?: AppLocale; take?: number },
  ): Promise<FormulaRecord[]> {
    const locale = options?.locale ?? "de";
    const take = Math.min(50, Math.max(1, options?.take ?? MAX_FORMULA_HISTORY));
    const rows = (await prisma.customerNote.findMany({
      where: { customerId, kind: "formula" },
      orderBy: { createdAt: "desc" },
      take,
    })) as NoteRow[];
    return rows
      .flatMap((row) => {
        const record = parseFormulaNote(row, locale);
        return record ? [record] : [];
      })
      .sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime());
  }
}
