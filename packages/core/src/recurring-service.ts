/**
 * Recurring appointments — "the same thing, every six weeks".
 *
 * A standing arrangement is a promise about a WALL CLOCK, not about an instant: the
 * customer agreed to Tuesday at 10:00 and expects Tuesday at 10:00 in March as well as in
 * November. Every advance in this file therefore goes through the salon calendar in
 * `./time` rather than through millisecond arithmetic, which would silently move a whole
 * client list by an hour on the last Sunday of October.
 *
 * The scheduler is a cron: `materialiseDue` turns whatever is due into real appointments,
 * is safe to run twice, and never books over a colleague.
 */

import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { withSerializationRetry } from "./repositories";
import {
  endOfSalonDay,
  formatInSalonZone,
  parseSalonDay,
  salonDayKey,
  salonDayOfWeek,
  startOfSalonDay,
  zonedMinutesToUtc,
} from "./time";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1_440;
const DAYS_PER_WEEK = 7;
const SALON_TIME_PATTERN = /(\d{1,2})\D(\d{2})/;

export const MIN_SERIES_INTERVAL_WEEKS = 1;

/** Six months. Past that it is not a recurring arrangement, it is a reminder to rebook. */
export const MAX_SERIES_INTERVAL_WEEKS = 26;

/** Two years of standing appointments is already further than any rota is planned. */
export const MAX_SERIES_HORIZON_DAYS = 730;

export const MAX_SERIES_OCCURRENCES = 104;

/**
 * How far ahead the scheduler materialises. Eight weeks means even a six or eight week
 * series always has its next occurrence sitting in the book, so the customer gets their
 * reminder and the staff can see the day is spoken for, while staying close enough that a
 * rota change does not invalidate months of bookings at once.
 */
export const MATERIALISE_HORIZON_DAYS = 56;

/**
 * How far the scheduler may move an occurrence when the exact slot is taken. Two hours on
 * the SAME salon day, never onto another day: the customer arranged their week around that
 * day, and a receptionist offering "same day, an hour later" is a normal conversation
 * whereas "same time, next Thursday" is a different appointment and needs a human.
 */
export const SERIES_SLOT_TOLERANCE_MIN = 120;

/** The salon writes its paper book in quarter hours. */
export const SERIES_SLOT_STEP_MIN = 15;

/**
 * Mirrors MIN_BOOKING_LEAD_MINUTES in booking-service. Duplicated rather than imported so
 * this file does not depend on the booking module; if that constant moves, move this one.
 */
export const SERIES_LEAD_MINUTES = 120;

const MAX_OCCURRENCES_PER_RUN = 12;
const MAX_CATCH_UP_STEPS = 520;

/**
 * A standing customer has already committed to the cadence and is known to the salon, so
 * asking for a deposit every six weeks is friction with no upside. One constant so the
 * owner can reverse it in one line if a series ever no-shows.
 */
export const SERIES_APPOINTMENT_DEPOSIT_REQUIRED = false;

export type OccurrenceStatus =
  | "booked"
  | "moved"
  | "already_booked"
  | "needs_attention"
  | "skipped_past"
  | "series_completed";

/**
 * One series blew up — a lost connection, a serialization conflict that outlived its
 * retries. The run carries on with the other series and reports this one for a human.
 */
export const SERIES_MATERIALISATION_FAILED = "SERIES_MATERIALISATION_FAILED";

export type OccurrenceOutcome = {
  seriesId: string;
  customerId: string;
  serviceId: string;
  locale: string;
  /** The instant the cadence asked for, before any tolerance shift. */
  occurrenceAt: Date;
  status: OccurrenceStatus;
  appointmentId?: string;
  staffId?: string;
  startsAt?: Date;
  endsAt?: Date;
  /** Signed wall-clock minutes between the ideal slot and the booked one. */
  offsetMinutes?: number;
  reason?: string;
  /** Only set alongside `SERIES_MATERIALISATION_FAILED`: what actually went wrong. */
  error?: string;
};

export type MaterialiseReport = {
  now: Date;
  horizon: Date;
  seriesConsidered: number;
  booked: number;
  moved: number;
  needsAttention: number;
  skipped: number;
  outcomes: OccurrenceOutcome[];
};

export type SeriesActionResult = {
  seriesId: string;
  active: boolean;
  nextAt: Date;
  endsAt: Date | null;
  reason?: string;
};

type Window = { startMin: number; endMin: number };
type Interval = { startsAt: Date; endsAt: Date };

type DayPlan = {
  businessWindows: Window[];
  rulesByStaff: Map<string, Window[]>;
  blockedByStaff: Map<string, Interval[]>;
};

type ChosenSlot = {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  blockedEndsAt: Date;
  offsetMinutes: number;
};

type CommitResult =
  | { kind: "raced" }
  | { kind: "advanced" }
  | { kind: "duplicate"; appointmentId: string }
  | { kind: "conflict" }
  | { kind: "created"; appointmentId: string };

type AppointmentClient = Pick<typeof prisma, "appointment">;

const SERIALIZABLE_TX_OPTIONS = {
  isolationLevel: "Serializable",
  maxWait: 5_000,
  timeout: 10_000,
} as const;

const instantSchema = z.union([z.date(), z.string().datetime({ offset: true })]);

const createSeriesSchema = z
  .object({
    customerId: z.string().trim().min(1).max(64),
    serviceId: z.string().trim().min(1).max(64),
    staffId: z.string().trim().min(1).max(64).optional(),
    intervalWeeks: z.number().int().min(MIN_SERIES_INTERVAL_WEEKS).max(MAX_SERIES_INTERVAL_WEEKS),
    firstAt: instantSchema,
    endsAt: instantSchema.nullish(),
    occurrences: z.number().int().min(1).max(MAX_SERIES_OCCURRENCES).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).default("en"),
    channel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
  })
  .strict()
  .refine(
    (value) =>
      value.endsAt === undefined || value.endsAt === null || value.occurrences === undefined,
    { message: "Pass either endsAt or occurrences, not both." },
  );

export type CreateSeriesInput = z.input<typeof createSeriesSchema>;

function toInstant(value: Date | string): Date {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error("INVALID_INSTANT");
  return instant;
}

/**
 * Minutes past salon midnight as the CLOCK ON THE WALL reads them.
 *
 * Not `instant - startOfSalonDay`: on the last Sunday of October that difference is 660
 * for a 10:00 appointment because the salon day is 25 hours long, and re-anchoring 660
 * minutes on any other day yields 11:00. Reading the formatted hour and minute back out of
 * the salon zone is the only value that survives both transitions.
 */
export function salonWallMinutes(instant: Date): number {
  const label = formatInSalonZone(instant, "en", { hour: "2-digit", minute: "2-digit" });
  const match = SALON_TIME_PATTERN.exec(label);
  if (!match) throw new Error("SALON_TIME_UNREADABLE");
  return Number(match[1]) * 60 + Number(match[2]);
}

function shiftSalonDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The one advance rule for a series: same weekday, same wall clock, `weeks * 7` calendar
 * days later. Because the number of days is always a multiple of seven the weekday is
 * preserved by construction, and because the time of day is re-anchored through the salon
 * zone it is 10:00 on both sides of every DST transition. Successive advances are always
 * taken from the previous scheduled occurrence, never from "now", so nothing accumulates:
 * nine advances of six weeks land exactly 378 days later, to the minute.
 */
export function addSalonWeeks(instant: Date, weeks: number): Date {
  const minutes = salonWallMinutes(instant);
  const targetKey = shiftSalonDayKey(salonDayKey(instant), weeks * DAYS_PER_WEEK);
  return zonedMinutesToUtc(parseSalonDay(targetKey), minutes);
}

/** The next `count` occurrences of a cadence, for confirming a plan before saving it. */
export function previewOccurrences(
  firstAt: Date,
  intervalWeeks: number,
  count: number,
  endsAt?: Date | null,
): Date[] {
  if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1) throw new Error("INVALID_INTERVAL");
  const occurrences: Date[] = [];
  let cursor = firstAt;
  for (let index = 0; index < count; index += 1) {
    if (endsAt && cursor > endsAt) break;
    occurrences.push(cursor);
    cursor = addSalonWeeks(cursor, intervalWeeks);
  }
  return occurrences;
}

/**
 * Nearest-first search order in wall-clock minutes: the exact slot, then +15, -15, +30 and
 * outwards. A tie prefers the LATER slot — a customer who turns up at the time they
 * originally agreed is then early rather than late.
 */
export function toleranceOffsets(
  toleranceMin = SERIES_SLOT_TOLERANCE_MIN,
  stepMin = SERIES_SLOT_STEP_MIN,
): number[] {
  const offsets = [0];
  for (let delta = stepMin; delta <= toleranceMin; delta += stepMin) {
    offsets.push(delta, -delta);
  }
  return offsets;
}

function overlaps(interval: Interval, startsAt: Date, endsAt: Date): boolean {
  return interval.startsAt < endsAt && interval.endsAt > startsAt;
}

function windowCovers(windows: Window[], startMin: number, endMin: number): boolean {
  return windows.some((window) => startMin >= window.startMin && endMin <= window.endMin);
}

async function loadDayPlan(
  staffIds: string[],
  dayAnchor: Date,
  spanMinutes: number,
): Promise<DayPlan> {
  const dayStart = startOfSalonDay(dayAnchor);
  const dayEnd = endOfSalonDay(dayAnchor);
  const dayOfWeek = salonDayOfWeek(dayAnchor);

  const [businessHours, rules, timeOffs, appointments] = await Promise.all([
    prisma.businessHours.findMany({ where: { dayOfWeek, isOpen: true } }),
    prisma.staffAvailabilityRule.findMany({ where: { staffId: { in: staffIds }, dayOfWeek } }),
    prisma.staffTimeOff.findMany({
      where: { staffId: { in: staffIds }, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
    }),
    prisma.appointment.findMany({
      where: {
        staffId: { in: staffIds },
        status: { not: "cancelled" },
        startsAt: { gte: new Date(dayStart.getTime() - spanMinutes * MS_PER_MINUTE), lt: dayEnd },
      },
      select: { staffId: true, startsAt: true, endsAt: true, service: { select: { bufferAfterMin: true } } },
    }),
  ]);

  const rulesByStaff = new Map<string, Window[]>();
  for (const rule of rules) {
    const entries = rulesByStaff.get(rule.staffId) ?? [];
    entries.push({ startMin: rule.startMin, endMin: rule.endMin });
    rulesByStaff.set(rule.staffId, entries);
  }

  const blockedByStaff = new Map<string, Interval[]>();
  const addBlocked = (staffId: string, interval: Interval) => {
    const entries = blockedByStaff.get(staffId) ?? [];
    entries.push(interval);
    blockedByStaff.set(staffId, entries);
  };
  for (const timeOff of timeOffs) {
    addBlocked(timeOff.staffId, { startsAt: timeOff.startsAt, endsAt: timeOff.endsAt });
  }
  for (const appointment of appointments) {
    if (!appointment.staffId) continue;
    addBlocked(appointment.staffId, {
      startsAt: appointment.startsAt,
      endsAt: new Date(
        appointment.endsAt.getTime() + appointment.service.bufferAfterMin * MS_PER_MINUTE,
      ),
    });
  }

  return {
    businessWindows: businessHours.map((entry) => ({
      startMin: entry.startMin,
      endMin: entry.endMin,
    })),
    rulesByStaff,
    blockedByStaff,
  };
}

/**
 * Defensive availability check, run here because booking-service is not allowed to grow a
 * series-aware entry point in this phase. It repeats the three rules the booking engine
 * applies — the salon is open, the staff member works then, and neither an appointment
 * (including its clean-up buffer) nor a time-off overlaps — so a materialised occurrence
 * lands on a slot the public booking flow would also have offered.
 */
function slotIsFree(
  plan: DayPlan,
  staffId: string,
  wallStartMin: number,
  wallEndMin: number,
  startsAt: Date,
  blockedEndsAt: Date,
): boolean {
  if (!windowCovers(plan.businessWindows, wallStartMin, wallEndMin)) return false;
  const rules = plan.rulesByStaff.get(staffId) ?? [];
  if (!windowCovers(rules, wallStartMin, wallEndMin)) return false;
  const blocked = plan.blockedByStaff.get(staffId) ?? [];
  return !blocked.some((interval) => overlaps(interval, startsAt, blockedEndsAt));
}

async function hasStaffConflict(
  client: AppointmentClient,
  staffId: string,
  startsAt: Date,
  blockedEndsAt: Date,
  spanMinutes: number,
): Promise<boolean> {
  const candidates = await client.appointment.findMany({
    where: {
      staffId,
      status: { not: "cancelled" },
      startsAt: {
        gte: new Date(startsAt.getTime() - spanMinutes * MS_PER_MINUTE),
        lt: blockedEndsAt,
      },
    },
    select: { endsAt: true, service: { select: { bufferAfterMin: true } } },
  });
  return candidates.some(
    (item) =>
      new Date(item.endsAt.getTime() + item.service.bufferAfterMin * MS_PER_MINUTE) > startsAt,
  );
}

async function readBlockingSpanMinutes(): Promise<number> {
  const aggregate = await prisma.service.aggregate({
    _max: { durationMin: true, bufferAfterMin: true },
  });
  return (aggregate._max.durationMin ?? 0) + (aggregate._max.bufferAfterMin ?? 0);
}

function loadDueSeries(horizon: Date) {
  return prisma.recurringSeries.findMany({
    where: { active: true, nextAt: { lt: horizon } },
    include: {
      service: { select: { durationMin: true, bufferAfterMin: true, isActive: true } },
      customer: { select: { deletedAt: true, anonymizedAt: true } },
    },
    orderBy: { nextAt: "asc" },
  });
}

type DueSeries = Awaited<ReturnType<typeof loadDueSeries>>[number];

function outcomeFor(
  series: Pick<DueSeries, "id" | "customerId" | "serviceId" | "locale">,
  occurrenceAt: Date,
  status: OccurrenceStatus,
  extra: Partial<OccurrenceOutcome> = {},
): OccurrenceOutcome {
  return {
    seriesId: series.id,
    customerId: series.customerId,
    serviceId: series.serviceId,
    locale: series.locale,
    occurrenceAt,
    status,
    ...extra,
  };
}

export class RecurringService {
  /**
   * Register a standing arrangement. Nothing is booked here: the first occurrence becomes
   * `nextAt` and the scheduler picks it up once it is inside the materialisation horizon,
   * so a series created a year out does not squat on a slot the rota has not planned yet.
   */
  async createSeries(rawInput: unknown, now = new Date()) {
    const input = createSeriesSchema.parse(rawInput);
    const firstAt = toInstant(input.firstAt);

    if (firstAt.getTime() < now.getTime() + SERIES_LEAD_MINUTES * MS_PER_MINUTE) {
      throw new Error("SERIES_START_TOO_SOON");
    }
    const horizonLimit = new Date(now.getTime() + MAX_SERIES_HORIZON_DAYS * MS_PER_DAY);
    if (firstAt >= horizonLimit) throw new Error("SERIES_START_TOO_FAR_AHEAD");

    let endsAt: Date | null = null;
    if (input.endsAt !== undefined && input.endsAt !== null) {
      endsAt = toInstant(input.endsAt);
      if (endsAt < firstAt) throw new Error("SERIES_END_BEFORE_START");
      if (endsAt > horizonLimit) throw new Error("SERIES_END_TOO_FAR_AHEAD");
    } else if (input.occurrences !== undefined) {
      const last = addSalonWeeks(firstAt, input.intervalWeeks * (input.occurrences - 1));
      if (last > horizonLimit) throw new Error("SERIES_END_TOO_FAR_AHEAD");
      endsAt = endOfSalonDay(last);
    }

    const [customer, service] = await Promise.all([
      prisma.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, deletedAt: true, anonymizedAt: true },
      }),
      prisma.service.findUnique({
        where: { id: input.serviceId },
        select: { id: true, isActive: true },
      }),
    ]);
    if (!customer || customer.deletedAt || customer.anonymizedAt) {
      throw new Error("CUSTOMER_NOT_FOUND");
    }
    if (!service || !service.isActive) throw new Error("SERVICE_NOT_FOUND");

    if (input.staffId) {
      const link = await prisma.staffService.findFirst({
        where: { staffId: input.staffId, serviceId: input.serviceId, staff: { isBookable: true } },
        select: { id: true },
      });
      if (!link) throw new Error("STAFF_NOT_ELIGIBLE");
    }

    return prisma.recurringSeries.create({
      data: {
        customerId: input.customerId,
        serviceId: input.serviceId,
        staffId: input.staffId ?? null,
        intervalWeeks: input.intervalWeeks,
        nextAt: firstAt,
        endsAt,
        active: true,
        locale: input.locale,
        channel: input.channel,
      },
    });
  }

  /**
   * The scheduler. Every series whose `nextAt` falls inside the horizon is walked forward
   * one occurrence at a time until it leaves the horizon or ends.
   *
   * Idempotency does not rest on a uniqueness constraint, because Appointment has none to
   * lean on. It rests on the cursor: an occurrence is only ever booked by the transaction
   * that also moves `nextAt` off it, with `UPDATE ... WHERE nextAt = <the value we read>`.
   * A second scheduler running concurrently, or the same job replayed after a crash,
   * matches zero rows and stops without writing. Inside that same transaction a second,
   * belt-and-braces check looks for a live appointment already carrying this `seriesId` on
   * this salon day, which also covers the case where a member of staff reset `nextAt` by
   * hand after the occurrence was booked.
   *
   * Each series is isolated: a lost connection on one of them is reported as
   * `SERIES_MATERIALISATION_FAILED` and the run continues. A cron that abandons two
   * hundred standing customers because the third one hit a deadlock is worse than useless,
   * and the caller would lose the report for the ones already written.
   */
  async materialiseDue(now = new Date(), horizon?: Date): Promise<MaterialiseReport> {
    const effectiveHorizon =
      horizon ?? new Date(now.getTime() + MATERIALISE_HORIZON_DAYS * MS_PER_DAY);
    if (effectiveHorizon <= now) throw new Error("INVALID_HORIZON");

    const [seriesList, spanMinutes] = await Promise.all([
      loadDueSeries(effectiveHorizon),
      readBlockingSpanMinutes(),
    ]);

    const outcomes: OccurrenceOutcome[] = [];
    for (const series of seriesList) {
      outcomes.push(...(await this.materialiseSeries(series, now, effectiveHorizon, spanMinutes)));
    }

    return {
      now,
      horizon: effectiveHorizon,
      seriesConsidered: seriesList.length,
      booked: outcomes.filter((entry) => entry.status === "booked").length,
      moved: outcomes.filter((entry) => entry.status === "moved").length,
      needsAttention: outcomes.filter((entry) => entry.status === "needs_attention").length,
      skipped: outcomes.filter((entry) => entry.status === "skipped_past").length,
      outcomes,
    };
  }

  private async materialiseSeries(
    series: DueSeries,
    now: Date,
    horizon: Date,
    spanMinutes: number,
  ): Promise<OccurrenceOutcome[]> {
    const outcomes: OccurrenceOutcome[] = [];
    let cursor = series.nextAt;

    try {
      if (series.customer.deletedAt || series.customer.anonymizedAt) {
        await this.deactivate(series.id);
        return [
          outcomeFor(series, series.nextAt, "series_completed", { reason: "CUSTOMER_UNAVAILABLE" }),
        ];
      }
      if (!series.service.isActive) {
        return [
          outcomeFor(series, series.nextAt, "needs_attention", { reason: "SERVICE_INACTIVE" }),
        ];
      }

      const staffIds = await this.eligibleStaffIds(series.serviceId, series.staffId);
      const preferredStaffId = series.staffId ?? (await this.previousStaffId(series.id));
      const earliest = new Date(now.getTime() + SERIES_LEAD_MINUTES * MS_PER_MINUTE);

      for (let step = 0; step < MAX_OCCURRENCES_PER_RUN; step += 1) {
        if (cursor >= horizon) break;
        if (series.endsAt && cursor > series.endsAt) {
          await this.deactivate(series.id);
          outcomes.push(
            outcomeFor(series, cursor, "series_completed", { reason: "SERIES_END_REACHED" }),
          );
          break;
        }

        const advanceTo = addSalonWeeks(cursor, series.intervalWeeks);

        if (cursor < earliest) {
          const committed = await this.commit(series, cursor, advanceTo, null, spanMinutes);
          if (committed.kind === "raced") break;
          outcomes.push(
            outcomeFor(series, cursor, "skipped_past", { reason: "OCCURRENCE_IN_PAST" }),
          );
          cursor = advanceTo;
          continue;
        }

        const chosen =
          staffIds.length === 0
            ? null
            : await this.planSlot(series, cursor, staffIds, preferredStaffId, spanMinutes);
        const committed = await this.commit(series, cursor, advanceTo, chosen, spanMinutes);

        if (committed.kind === "raced") break;
        if (committed.kind === "duplicate") {
          outcomes.push(
            outcomeFor(series, cursor, "already_booked", { appointmentId: committed.appointmentId }),
          );
        } else if (committed.kind === "created" && chosen) {
          outcomes.push(
            outcomeFor(series, cursor, chosen.offsetMinutes === 0 ? "booked" : "moved", {
              appointmentId: committed.appointmentId,
              staffId: chosen.staffId,
              startsAt: chosen.startsAt,
              endsAt: chosen.endsAt,
              offsetMinutes: chosen.offsetMinutes,
            }),
          );
        } else {
          outcomes.push(
            outcomeFor(series, cursor, "needs_attention", {
              reason:
                staffIds.length === 0
                  ? "STAFF_NOT_ELIGIBLE"
                  : committed.kind === "conflict"
                    ? "SLOT_TAKEN_WHILE_BOOKING"
                    : "NO_SLOT_WITHIN_TOLERANCE",
            }),
          );
        }
        cursor = advanceTo;
      }
    } catch (error) {
      outcomes.push(
        outcomeFor(series, cursor, "needs_attention", {
          reason: SERIES_MATERIALISATION_FAILED,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    return outcomes;
  }

  private async eligibleStaffIds(serviceId: string, staffId: string | null): Promise<string[]> {
    const links = await prisma.staffService.findMany({
      where: {
        serviceId,
        staff: { isBookable: true },
        ...(staffId ? { staffId } : {}),
      },
      select: { staffId: true },
      orderBy: { staffId: "asc" },
    });
    return links.map((link) => link.staffId);
  }

  /**
   * Who cut this customer's hair last time in this series. Continuity is worth something
   * to a regular, so that person is tried first — but only as a tie-break, never at the
   * cost of a worse time, and never at all when the series names a staff member outright.
   */
  private async previousStaffId(seriesId: string): Promise<string | null> {
    const previous = await prisma.appointment.findFirst({
      where: { seriesId, staffId: { not: null }, status: { not: "cancelled" } },
      orderBy: { startsAt: "desc" },
      select: { staffId: true },
    });
    return previous?.staffId ?? null;
  }

  private async planSlot(
    series: DueSeries,
    occurrenceAt: Date,
    staffIds: string[],
    preferredStaffId: string | null,
    spanMinutes: number,
  ): Promise<ChosenSlot | null> {
    const plan = await loadDayPlan(staffIds, occurrenceAt, spanMinutes);
    const idealMinutes = salonWallMinutes(occurrenceAt);
    const dayAnchor = parseSalonDay(salonDayKey(occurrenceAt));
    const blockedMinutes = series.service.durationMin + series.service.bufferAfterMin;
    const ordered =
      preferredStaffId && staffIds.includes(preferredStaffId)
        ? [preferredStaffId, ...staffIds.filter((id) => id !== preferredStaffId)]
        : staffIds;

    for (const offset of toleranceOffsets()) {
      const wallStartMin = idealMinutes + offset;
      const wallEndMin = wallStartMin + blockedMinutes;
      if (wallStartMin < 0 || wallEndMin > MINUTES_PER_DAY) continue;

      const startsAt = zonedMinutesToUtc(dayAnchor, wallStartMin);
      const endsAt = new Date(startsAt.getTime() + series.service.durationMin * MS_PER_MINUTE);
      const blockedEndsAt = new Date(startsAt.getTime() + blockedMinutes * MS_PER_MINUTE);

      for (const staffId of ordered) {
        if (!slotIsFree(plan, staffId, wallStartMin, wallEndMin, startsAt, blockedEndsAt)) continue;
        return { staffId, startsAt, endsAt, blockedEndsAt, offsetMinutes: offset };
      }
    }
    return null;
  }

  /**
   * Move the cursor and, if a slot was found, book it — in one serializable transaction so
   * the two can never disagree. When no slot was found the cursor still moves: a series
   * that stalls on one impossible occurrence would re-report the same date on every run
   * and, once that date is in the past, quietly swallow it anyway. Moving on keeps the
   * cadence intact so the NEXT occurrence works as soon as the rota is fixed, and the
   * `needs_attention` outcome is what tells the salon to call the customer.
   */
  private async commit(
    series: DueSeries,
    occurrenceAt: Date,
    advanceTo: Date,
    chosen: ChosenSlot | null,
    spanMinutes: number,
  ): Promise<CommitResult> {
    return withSerializationRetry(() =>
      prisma.$transaction(async (tx): Promise<CommitResult> => {
        const { count } = await tx.recurringSeries.updateMany({
          where: { id: series.id, active: true, nextAt: occurrenceAt },
          data: { nextAt: advanceTo },
        });
        if (count === 0) return { kind: "raced" };
        if (!chosen) return { kind: "advanced" };

        const duplicate = await tx.appointment.findFirst({
          where: {
            seriesId: series.id,
            status: { not: "cancelled" },
            startsAt: {
              gte: startOfSalonDay(occurrenceAt),
              lt: endOfSalonDay(occurrenceAt),
            },
          },
          select: { id: true },
        });
        if (duplicate) return { kind: "duplicate", appointmentId: duplicate.id };

        const conflict = await hasStaffConflict(
          tx,
          chosen.staffId,
          chosen.startsAt,
          chosen.blockedEndsAt,
          spanMinutes,
        );
        if (conflict) return { kind: "conflict" };

        const appointment = await tx.appointment.create({
          data: {
            customerId: series.customerId,
            serviceId: series.serviceId,
            staffId: chosen.staffId,
            seriesId: series.id,
            startsAt: chosen.startsAt,
            endsAt: chosen.endsAt,
            locale: series.locale,
            status: "confirmed",
            sourceChannel: series.channel,
            depositRequired: SERIES_APPOINTMENT_DEPOSIT_REQUIRED,
            statusHistory: {
              create: { status: "confirmed", reason: "recurring series occurrence" },
            },
          },
          select: { id: true },
        });
        return { kind: "created", appointmentId: appointment.id };
      }, SERIALIZABLE_TX_OPTIONS),
    );
  }

  private async deactivate(seriesId: string): Promise<void> {
    await prisma.recurringSeries.updateMany({
      where: { id: seriesId, active: true },
      data: { active: false },
    });
  }

  /**
   * Customer is away for one round. The cadence is not rescheduled, it is consumed: the
   * cursor moves exactly one interval from the occurrence that was skipped, so the series
   * stays on the same weekday and wall clock instead of sliding by however long the pause
   * happened to last.
   */
  async skipNext(seriesId: string, reason?: string): Promise<SeriesActionResult> {
    const series = await prisma.recurringSeries.findUnique({ where: { id: seriesId } });
    if (!series) throw new Error("SERIES_NOT_FOUND");
    const advanceTo = addSalonWeeks(series.nextAt, series.intervalWeeks);
    const { count } = await prisma.recurringSeries.updateMany({
      where: { id: seriesId, nextAt: series.nextAt },
      data: { nextAt: advanceTo },
    });
    if (count === 0) throw new Error("SERIES_CHANGED");

    const finished = series.endsAt !== null && advanceTo > series.endsAt;
    if (finished) await this.deactivate(seriesId);
    return {
      seriesId,
      active: series.active && !finished,
      nextAt: advanceTo,
      endsAt: series.endsAt,
      reason,
    };
  }

  /** Stop generating without losing the cadence; `nextAt` is left exactly where it is. */
  async pause(seriesId: string): Promise<SeriesActionResult> {
    const existing = await prisma.recurringSeries.findUnique({ where: { id: seriesId } });
    if (!existing) throw new Error("SERIES_NOT_FOUND");
    const series = await prisma.recurringSeries.update({
      where: { id: seriesId },
      data: { active: false },
    });
    return { seriesId, active: false, nextAt: series.nextAt, endsAt: series.endsAt };
  }

  /**
   * Resume on the original phase. `nextAt` is advanced one whole interval at a time until
   * it is far enough in the future to be bookable, so a series paused for four months comes
   * back on the same weekday at the same time rather than on whatever day the resume was
   * clicked.
   */
  async resume(seriesId: string, now = new Date()): Promise<SeriesActionResult> {
    const series = await prisma.recurringSeries.findUnique({ where: { id: seriesId } });
    if (!series) throw new Error("SERIES_NOT_FOUND");

    const earliest = new Date(now.getTime() + SERIES_LEAD_MINUTES * MS_PER_MINUTE);
    let nextAt = series.nextAt;
    for (let step = 0; step < MAX_CATCH_UP_STEPS && nextAt < earliest; step += 1) {
      nextAt = addSalonWeeks(nextAt, series.intervalWeeks);
    }
    if (nextAt < earliest) throw new Error("SERIES_TOO_STALE");

    if (series.endsAt && nextAt > series.endsAt) {
      await this.deactivate(seriesId);
      return {
        seriesId,
        active: false,
        nextAt,
        endsAt: series.endsAt,
        reason: "SERIES_END_REACHED",
      };
    }

    const updated = await prisma.recurringSeries.update({
      where: { id: seriesId },
      data: { active: true, nextAt },
    });
    return { seriesId, active: true, nextAt: updated.nextAt, endsAt: updated.endsAt };
  }

  /**
   * Stop the arrangement for good. Appointments already in the book are never touched by
   * default — the past is a record of work done and money taken, and future occurrences
   * that were already agreed stay agreed. Pass `cancelFutureAppointments` to release the
   * slots the salon no longer wants held; even then only appointments AFTER the end date
   * that are still pending or confirmed are cancelled, and nothing is ever deleted.
   */
  async endSeries(
    seriesId: string,
    options: { at?: Date; cancelFutureAppointments?: boolean; reason?: string } = {},
  ): Promise<SeriesActionResult & { cancelledAppointmentIds: string[] }> {
    const at = options.at ?? new Date();
    const series = await prisma.recurringSeries.findUnique({ where: { id: seriesId } });
    if (!series) throw new Error("SERIES_NOT_FOUND");

    const updated = await prisma.recurringSeries.update({
      where: { id: seriesId },
      data: { active: false, endsAt: at },
    });

    const cancelledAppointmentIds: string[] = [];
    if (options.cancelFutureAppointments) {
      const reason = options.reason ?? "recurring series ended";
      const upcoming = await prisma.appointment.findMany({
        where: { seriesId, startsAt: { gte: at }, status: { in: ["pending", "confirmed"] } },
        select: { id: true },
      });
      for (const appointment of upcoming) {
        await prisma.appointment.update({
          where: { id: appointment.id },
          data: {
            status: "cancelled",
            cancellationReason: reason,
            statusHistory: { create: { status: "cancelled", reason } },
          },
        });
        cancelledAppointmentIds.push(appointment.id);
      }
    }

    return {
      seriesId,
      active: false,
      nextAt: updated.nextAt,
      endsAt: updated.endsAt,
      reason: options.reason,
      cancelledAppointmentIds,
    };
  }

  /**
   * Drop one occurrence and keep the arrangement. The appointment keeps its `seriesId` so
   * the history still shows which series it belonged to, and `nextAt` is deliberately not
   * touched: this occurrence has already been consumed by the scheduler.
   */
  async cancelOccurrence(appointmentId: string, reason: string) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, seriesId: true, status: true },
    });
    if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
    if (!appointment.seriesId) throw new Error("APPOINTMENT_NOT_IN_SERIES");
    if (appointment.status === "cancelled") {
      return prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    }
    return prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: "cancelled",
        cancellationReason: reason,
        statusHistory: { create: { status: "cancelled", reason } },
      },
    });
  }

  async getSeries(seriesId: string) {
    const series = await prisma.recurringSeries.findUnique({
      where: { id: seriesId },
      include: {
        service: { select: { slug: true, durationMin: true } },
        staff: { select: { id: true, displayName: true } },
        appointments: { orderBy: { startsAt: "desc" }, take: 20 },
      },
    });
    if (!series) throw new Error("SERIES_NOT_FOUND");
    return series;
  }

  async listSeriesForCustomer(customerId: string, includeInactive = false) {
    return prisma.recurringSeries.findMany({
      where: { customerId, ...(includeInactive ? {} : { active: true }) },
      include: { service: { select: { slug: true } }, staff: { select: { displayName: true } } },
      orderBy: { nextAt: "asc" },
    });
  }
}
