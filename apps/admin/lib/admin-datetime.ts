import type { AppLocale } from "@hair-simo/i18n";
import {
  SALON_TIME_ZONE,
  formatInSalonZone,
  parseSalonDay,
  salonDayKey,
  zonedMinutesToUtc,
} from "@hair-simo/core/time";

/**
 * Date handling for the admin UI.
 *
 * Every value the backoffice shows or edits belongs to the salon's wall clock, but the
 * admin runs on Cloud Run (UTC) on the server and on a receptionist's laptop in the
 * browser. `Date#toLocaleString` and friends therefore render a different hour in each
 * of the two places, and `<input type="datetime-local">` is worse than that: its value
 * is a bare wall-clock string with no zone at all, so `new Date(value)` silently reads
 * it in the host zone and writing it back moves the appointment by the offset.
 *
 * Everything here funnels through packages/core/src/time.ts. Nothing in this module
 * touches the host zone, and nothing imports Prisma, so it is safe inside components
 * marked "use client".
 */

export type AdminInstant = Date | string | number;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1_440;
const DATETIME_LOCAL_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** 2024-01-07 was a Sunday, so index 0..6 lines up with `Date#getDay` and `dayOfWeek`. */
const WEEKDAY_REFERENCE_SUNDAY = "2024-01-07";

const salonWallClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: SALON_TIME_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

function toInstant(value: AdminInstant): Date {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Expected a valid instant, received ${String(value)}.`);
  }
  return instant;
}

/** Minutes since salon midnight, read off the salon wall clock rather than the host's. */
export function salonMinutesFromMidnight(value: AdminInstant): number {
  const [hours, minutes] = salonWallClock.format(toInstant(value)).split(":");
  return Number(hours) * MINUTES_PER_HOUR + Number(minutes);
}

/** "YYYY-MM-DD" for `<input type="date">`, in the salon's zone. */
export function toDateInputValue(value: AdminInstant): string {
  return salonDayKey(toInstant(value));
}

/** First day of the salon month containing `value`, as a `<input type="date">` value. */
export function salonMonthStartInputValue(value: AdminInstant): string {
  return `${toDateInputValue(value).slice(0, 7)}-01`;
}

/** Shift a "YYYY-MM-DD" salon day key by whole salon days, DST transitions included. */
export function shiftSalonDayKey(dayKey: string, days: number): string {
  return salonDayKey(zonedMinutesToUtc(parseSalonDay(dayKey), days * MINUTES_PER_DAY));
}

/** The instant at `minutesFromMidnight` on the salon day `dayKey`. */
export function salonInstantOnDay(dayKey: string, minutesFromMidnight: number): Date {
  return zonedMinutesToUtc(parseSalonDay(dayKey), minutesFromMidnight);
}

/**
 * Instant -> the "YYYY-MM-DDTHH:MM" a `<input type="datetime-local">` must show for the
 * salon to read the correct hour off the screen.
 */
export function toDateTimeLocalValue(value: AdminInstant): string {
  const instant = toInstant(value);
  return `${salonDayKey(instant)}T${salonWallClock.format(instant)}`;
}

/**
 * `<input type="datetime-local">` value -> the instant it denotes in the salon.
 *
 * `toDateTimeLocalValue` then `fromDateTimeLocalValue` is lossless to the minute. The
 * reverse is not, and cannot be: on the autumn DST day the wall clock repeats an hour,
 * and this resolves such a value to its first (CEST) occurrence, matching
 * `zonedMinutesToUtc`. A wall clock that the spring DST gap skips resolves forward past
 * the gap instead of throwing, so an editor can never end up with an unsaveable form.
 */
export function fromDateTimeLocalValue(value: string): Date {
  const match = DATETIME_LOCAL_PATTERN.exec(String(value).trim());
  if (!match) {
    throw new Error(
      `Invalid datetime-local value "${String(value)}". Expected format YYYY-MM-DDTHH:MM.`,
    );
  }
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid datetime-local value "${String(value)}". Time of day out of range.`);
  }
  return salonInstantOnDay(match[1], hours * MINUTES_PER_HOUR + minutes);
}

/** `<input type="datetime-local">` value -> the ISO string an API route expects. */
export function dateTimeLocalToIso(value: string): string {
  return fromDateTimeLocalValue(value).toISOString();
}

export function formatSalonDate(value: AdminInstant, locale: AppLocale): string {
  return formatInSalonZone(toInstant(value), locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatSalonTime(value: AdminInstant, locale: AppLocale): string {
  return formatInSalonZone(toInstant(value), locale, { hour: "2-digit", minute: "2-digit" });
}

export function formatSalonDateTime(value: AdminInstant, locale: AppLocale): string {
  return formatInSalonZone(toInstant(value), locale, { dateStyle: "medium", timeStyle: "short" });
}

export function formatSalonWeekday(
  value: AdminInstant,
  locale: AppLocale,
  weekday: "long" | "short" = "short",
): string {
  return formatInSalonZone(toInstant(value), locale, { weekday });
}

/** Day number alone, for calendar headers. */
export function formatSalonDayNumber(value: AdminInstant, locale: AppLocale): string {
  return formatInSalonZone(toInstant(value), locale, { day: "numeric" });
}

/** Weekday names indexed 0=Sunday..6=Saturday, matching `BusinessHours.dayOfWeek`. */
export function salonWeekdayNames(locale: AppLocale, weekday: "long" | "short" = "long"): string[] {
  return Array.from({ length: 7 }, (_, index) => {
    const day = parseSalonDay(shiftSalonDayKey(WEEKDAY_REFERENCE_SUNDAY, index));
    return formatSalonWeekday(day, locale, weekday);
  });
}
