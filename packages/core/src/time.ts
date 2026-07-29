/**
 * Canonical timezone module for the whole platform.
 *
 * The salon is a physical shop in Brixen / Bressanone, South Tyrol (Italy) and every
 * business rule — opening hours, staff availability rules, slot generation, reminder
 * copy — is expressed in the salon's local wall clock. The runtime is not: Cloud Run
 * containers run in UTC while developer machines usually run in Europe/Rome. Anything
 * that goes through the host's local timezone (`Date#setHours`, `Date#getDay`,
 * `Date#toLocaleString`) therefore produces a different answer in production than in
 * development, and jumps by an hour twice a year.
 *
 * Every conversion between "minutes from midnight in the salon" and an absolute UTC
 * instant must go through this module. It has no dependencies beyond the built-in
 * Intl time zone database.
 */

const DEFAULT_TIME_ZONE = "Europe/Rome";
const DEFAULT_LOCALE_TAG = "en-GB";
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1_440;
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * App locale -> BCP-47 tag used for every customer facing string.
 *
 * South Tyrol is officially bilingual German/Italian, so the German audience of this
 * salon is Italian-resident and writes Austrian rather than German standard German.
 * CLDR models exactly that: `de-IT` inherits `de-AT`, so January renders as "Jänner"
 * and not the "Januar" that `de-DE` would produce. That is the form actually used in
 * Brixen, which makes `de-IT` a correctness choice and not merely a cosmetic one.
 * Italian is `it-IT`. French is `fr-FR` (no francophone region of Italy is relevant
 * here; France is the reference locale for the language). English is `en-GB` rather
 * than `en-US` because it is read by European tourists and gives day-month order plus
 * a 24h clock, matching every other locale of the site.
 */
const SALON_LOCALE_TAGS: Record<string, string> = {
  de: "de-IT",
  it: "it-IT",
  fr: "fr-FR",
  en: "en-GB",
};

type ZonedWallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const displayFormatters = new Map<string, Intl.DateTimeFormat>();
const validatedTimeZones = new Set<string>();

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(timeZone: string): string {
  if (validatedTimeZones.has(timeZone)) return timeZone;
  if (!isValidTimeZone(timeZone)) {
    throw new Error(
      `Unknown IANA time zone "${timeZone}". Expected an identifier such as "Europe/Rome".`,
    );
  }
  validatedTimeZones.add(timeZone);
  return timeZone;
}

function resolveSalonTimeZone(): string {
  const configured = process.env.SALON_TIME_ZONE?.trim();
  if (!configured) return DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(configured)) {
    throw new Error(
      `Invalid SALON_TIME_ZONE "${configured}". Expected an IANA time zone identifier such as "Europe/Rome".`,
    );
  }
  return configured;
}

/**
 * The salon's own time zone. Resolved once at module load from `SALON_TIME_ZONE`,
 * defaulting to Europe/Rome. A misconfigured value fails loudly at boot rather than
 * silently shifting every appointment.
 */
export const SALON_TIME_ZONE = resolveSalonTimeZone();

function assertValidInstant(instant: Date, argument: string): number {
  const time = instant instanceof Date ? instant.getTime() : Number.NaN;
  if (Number.isNaN(time)) {
    throw new Error(`${argument} must be a valid Date, received ${String(instant)}.`);
  }
  return time;
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  partsFormatters.set(timeZone, formatter);
  return formatter;
}

function wallClockOf(epochMs: number, timeZone: string): ZonedWallClock {
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochMs));
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function utcEpochOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  if (year >= 0 && year <= 99) {
    const shifted = new Date(epoch);
    shifted.setUTCFullYear(year);
    return shifted.getTime();
  }
  return epoch;
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const wall = wallClockOf(epochMs, timeZone);
  const wallEpoch = utcEpochOf(
    wall.year,
    wall.month,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return wallEpoch - Math.floor(epochMs / MS_PER_SECOND) * MS_PER_SECOND;
}

/**
 * Resolve a salon-local wall clock to the UTC instant it denotes.
 *
 * A local wall clock is not a bijection with instants, so both irregular cases are
 * handled explicitly:
 *
 * - Ambiguous (autumn, last Sunday of October): 02:00-03:00 local happens twice, once
 *   at UTC+2 and once at UTC+1. We deliberately pick the FIRST/earlier occurrence,
 *   i.e. the offset still in force before the transition. A customer told "02:30"
 *   arrives at the first 02:30 of the day, and slot generation stays monotonic.
 * - Nonexistent (spring, last Sunday of March): 02:00-03:00 local never happens. We
 *   fall back to the offset in force before the gap, which shifts the result forward
 *   by the length of the gap (02:30 resolves to the instant that reads 03:30 local).
 *   This is the same "compatible" disambiguation Temporal, Luxon and date-fns-tz use,
 *   and it never yields an instant outside the requested day.
 */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number,
  timeZone: string,
): Date {
  const target = utcEpochOf(year, month, day, 0, 0, 0) + minutesFromMidnight * MS_PER_MINUTE;
  const offsetBefore = zoneOffsetMs(target - MS_PER_DAY, timeZone);
  const candidateOffsets = [
    offsetBefore,
    zoneOffsetMs(target, timeZone),
    zoneOffsetMs(target + MS_PER_DAY, timeZone),
  ];

  let earliest: number | null = null;
  for (const offset of candidateOffsets) {
    const candidate = target - offset;
    if (zoneOffsetMs(candidate, timeZone) !== offset) continue;
    if (earliest === null || candidate < earliest) earliest = candidate;
  }

  if (earliest !== null) return new Date(earliest);
  return new Date(target - offsetBefore);
}

/**
 * Day of week 0=Sunday..6=Saturday as observed in the salon, not on the server.
 * `BusinessHours.weekday` and `StaffAvailabilityRule.weekday` are indexed with this.
 */
export function salonDayOfWeek(instant: Date, timeZone: string = SALON_TIME_ZONE): number {
  const epochMs = assertValidInstant(instant, "instant");
  assertTimeZone(timeZone);
  const wall = wallClockOf(epochMs, timeZone);
  return new Date(utcEpochOf(wall.year, wall.month, wall.day, 0, 0, 0)).getUTCDay();
}

/**
 * Convert minutes-from-midnight in the salon's zone into the UTC instant it means.
 * `day` may be any instant that falls on the wanted calendar day in the salon's zone.
 * Values outside 0..1440 are allowed and roll into the adjacent salon day.
 */
export function zonedMinutesToUtc(
  day: Date,
  minutesFromMidnight: number,
  timeZone: string = SALON_TIME_ZONE,
): Date {
  const epochMs = assertValidInstant(day, "day");
  assertTimeZone(timeZone);
  if (!Number.isInteger(minutesFromMidnight)) {
    throw new Error(
      `minutesFromMidnight must be an integer number of minutes, received ${String(minutesFromMidnight)}.`,
    );
  }
  const wall = wallClockOf(epochMs, timeZone);
  return wallClockToUtc(wall.year, wall.month, wall.day, minutesFromMidnight, timeZone);
}

/** UTC instant of 00:00 local on the salon day containing `instant`. */
export function startOfSalonDay(instant: Date, timeZone: string = SALON_TIME_ZONE): Date {
  return zonedMinutesToUtc(instant, 0, timeZone);
}

/**
 * UTC instant of the salon day's end, as the EXCLUSIVE upper bound: the first instant
 * of the next salon day. Use with `<` / Prisma `lt`, never with `<=`. On DST days the
 * resulting interval is correctly 23 or 25 hours long, not 24.
 */
export function endOfSalonDay(instant: Date, timeZone: string = SALON_TIME_ZONE): Date {
  return zonedMinutesToUtc(instant, MINUTES_PER_DAY, timeZone);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

/** "YYYY-MM-DD" as seen in the salon's zone. Stable grouping and cache key. */
export function salonDayKey(instant: Date, timeZone: string = SALON_TIME_ZONE): string {
  const epochMs = assertValidInstant(instant, "instant");
  assertTimeZone(timeZone);
  const wall = wallClockOf(epochMs, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}`;
}

/** Inverse of {@link salonDayKey}: "2026-08-04" -> UTC instant of that salon midnight. */
export function parseSalonDay(dayKey: string, timeZone: string = SALON_TIME_ZONE): Date {
  assertTimeZone(timeZone);
  const match = DAY_KEY_PATTERN.exec(String(dayKey).trim());
  if (!match) {
    throw new Error(`Invalid salon day key "${String(dayKey)}". Expected format YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(utcEpochOf(year, month, day, 0, 0, 0));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid salon day key "${String(dayKey)}". No such calendar date.`);
  }
  return wallClockToUtc(year, month, day, 0, timeZone);
}

function resolveLocaleTag(locale: string): string {
  const normalized = String(locale).trim().toLowerCase();
  const exact = SALON_LOCALE_TAGS[normalized];
  if (exact) return exact;
  const base = normalized.split(/[-_]/)[0] ?? "";
  return SALON_LOCALE_TAGS[base] ?? DEFAULT_LOCALE_TAG;
}

function displayFormatter(
  cacheKey: string,
  factory: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  const cached = displayFormatters.get(cacheKey);
  if (cached) return cached;
  const formatter = factory();
  displayFormatters.set(cacheKey, formatter);
  return formatter;
}

/**
 * Locale-aware display string, always rendered in the salon's zone whatever the host
 * timezone is. This is what belongs in confirmation mails, reminders and admin views;
 * `Date#toLocaleString` renders in the server's zone and is wrong on Cloud Run.
 *
 * Defaults to a full date plus the time of day. Passing `opts` replaces the defaults
 * wholesale rather than merging, because Intl rejects `dateStyle`/`timeStyle` combined
 * with individual field options. The time zone always wins over anything in `opts`.
 */
export function formatInSalonZone(
  instant: Date,
  locale: string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  assertValidInstant(instant, "instant");
  const hasOverrides = opts !== undefined && Object.keys(opts).length > 0;
  const options: Intl.DateTimeFormatOptions = hasOverrides
    ? { ...opts }
    : { dateStyle: "full", timeStyle: "short" };
  if (
    options.hour !== undefined &&
    options.hour12 === undefined &&
    options.hourCycle === undefined
  ) {
    options.hourCycle = "h23";
  }
  options.timeZone = SALON_TIME_ZONE;
  return new Intl.DateTimeFormat(resolveLocaleTag(locale), options).format(instant);
}

function formatRangeDatePart(instant: Date, tag: string): string {
  return displayFormatter(
    `range-date:${tag}`,
    () =>
      new Intl.DateTimeFormat(tag, {
        timeZone: SALON_TIME_ZONE,
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
  ).format(instant);
}

function formatRangeTimePart(instant: Date, tag: string): string {
  return displayFormatter(
    `range-time:${tag}`,
    () =>
      new Intl.DateTimeFormat(tag, {
        timeZone: SALON_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
  ).format(instant);
}

/**
 * Appointment range for humans: "Di., 4. Aug. 2026, 08:00-09:15". Always the salon's
 * zone and a 24h clock, which every one of the four locales uses in practice. A range
 * spanning two salon days repeats the date on both sides.
 */
export function formatSalonTimeRange(start: Date, end: Date, locale: string): string {
  assertValidInstant(start, "start");
  assertValidInstant(end, "end");
  const tag = resolveLocaleTag(locale);
  const startDate = formatRangeDatePart(start, tag);
  const startTime = formatRangeTimePart(start, tag);
  const endTime = formatRangeTimePart(end, tag);
  if (salonDayKey(start) !== salonDayKey(end)) {
    return `${startDate}, ${startTime} - ${formatRangeDatePart(end, tag)}, ${endTime}`;
  }
  return `${startDate}, ${startTime}-${endTime}`;
}
