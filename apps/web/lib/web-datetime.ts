/**
 * Salon wall clock helpers for the public site.
 *
 * `<input type="date">` and `<input type="datetime-local">` speak bare wall-clock
 * strings that carry no offset, while every customer facing time on this site means the
 * salon's clock in Brixen and never the visitor's. Brixen is a tourist town, so the
 * visitor's browser is regularly in another zone: rendering an 08:00 appointment with
 * `toLocaleString` shows 07:00 in London and 02:00 in New York, and feeding a
 * datetime-local value straight back to the API moves the appointment by the offset.
 *
 * All zone maths lives in @hair-simo/core/time; this module only maps between the salon
 * clock and the string shapes the DOM and the JSON API use. It is imported from client
 * components, so the `/time` subpath is deliberate — the @hair-simo/core barrel pulls
 * Prisma into the browser bundle.
 */

import {
  SALON_TIME_ZONE,
  formatInSalonZone,
  parseSalonDay,
  salonDayKey,
  zonedMinutesToUtc,
} from "@hair-simo/core/time";

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const MINUTES_PER_HOUR = 60;

const salonClockParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: SALON_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export { SALON_TIME_ZONE };

function toInstant(value: Date | string, argument: string): Date {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`${argument} must be a valid date, received ${String(value)}.`);
  }
  return instant;
}

function parseWallClock(value: string): Date | null {
  const match = WALL_CLOCK_PATTERN.exec(String(value).trim());
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  try {
    return zonedMinutesToUtc(parseSalonDay(match[1]), hour * MINUTES_PER_HOUR + minute);
  } catch {
    return null;
  }
}

/** "YYYY-MM-DD" of the salon's current day, whatever zone the browser or server is in. */
export function salonTodayKey(now: Date = new Date()): string {
  return salonDayKey(now);
}

/** True for a "YYYY-MM-DD" salon day key that denotes a real calendar date. */
export function isSalonDayKey(value: string): boolean {
  const candidate = String(value).trim();
  if (!DAY_KEY_PATTERN.test(candidate)) return false;
  try {
    parseSalonDay(candidate);
    return true;
  } catch {
    return false;
  }
}

/** True for a "YYYY-MM-DDTHH:mm" value that {@link fromSalonWallClock} accepts. */
export function isSalonWallClock(value: string): boolean {
  return parseWallClock(value) !== null;
}

/**
 * Instant -> the `datetime-local` value a customer should see: the salon's wall clock,
 * "YYYY-MM-DDTHH:mm".
 */
export function toSalonWallClock(instant: Date | string): string {
  const date = toInstant(instant, "instant");
  let hour = "";
  let minute = "";
  for (const part of salonClockParts.formatToParts(date)) {
    if (part.type === "hour") hour = part.value;
    if (part.type === "minute") minute = part.value;
  }
  return `${salonDayKey(date)}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * Inverse of {@link toSalonWallClock}: read a `datetime-local` value as salon wall clock
 * and resolve it to the instant it denotes. Round trips exactly except at the two DST
 * seams, where a wall clock is not a bijection with instants: the hour skipped in spring
 * normalises forward, and the hour repeated in autumn resolves to its first occurrence.
 */
export function fromSalonWallClock(value: string): Date {
  const instant = parseWallClock(value);
  if (!instant) {
    throw new Error(`Invalid salon wall clock "${String(value)}". Expected YYYY-MM-DDTHH:mm.`);
  }
  return instant;
}

/** "08:00" in the salon's zone on a 24h clock. */
export function formatSalonClock(instant: Date | string, locale: string): string {
  return formatInSalonZone(toInstant(instant, "instant"), locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "08:00 MESZ" — the same clock time plus the zone it is stated in. */
export function formatSalonClockWithZone(instant: Date | string, locale: string): string {
  return formatInSalonZone(toInstant(instant, "instant"), locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Localised date and time of day, always in the salon's zone. */
export function formatSalonDateTime(instant: Date | string, locale: string): string {
  return formatInSalonZone(toInstant(instant, "instant"), locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
