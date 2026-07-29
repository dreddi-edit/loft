import { addMinutes, areIntervalsOverlapping } from "date-fns";
import { SALON_TIME_ZONE, zonedMinutesToUtc } from "./time";

export type Slot = { startsAt: Date; endsAt: Date };

export type AvailabilityWindow = {
  dayStart: Date;
  dayEnd: Date;
};

export type BlockedInterval = {
  startsAt: Date;
  endsAt: Date;
};

/**
 * Granularity of the offered start times. The salon writes its paper book in quarter
 * hours, so every published slot starts on a :00/:15/:30/:45 of the salon wall clock.
 */
export const SLOT_INTERVAL_MIN = 15;

/**
 * Turn a pair of minutes-from-midnight (`BusinessHours`, `StaffAvailabilityRule`) into
 * absolute instants.
 *
 * Both bounds are resolved against the salon wall clock of the day containing `day`,
 * never against the host clock, so the window is identical on a developer machine in
 * Europe/Rome and on a Cloud Run container in UTC. Because each bound is converted
 * independently, a 23 hour (spring forward) or 25 hour (fall back) salon day yields a
 * window of the correct absolute length rather than a nominal one.
 */
export function buildSalonWindow(
  day: Date,
  startMin: number,
  endMin: number,
  timeZone: string = SALON_TIME_ZONE,
): AvailabilityWindow {
  return {
    dayStart: zonedMinutesToUtc(day, startMin, timeZone),
    dayEnd: zonedMinutesToUtc(day, endMin, timeZone),
  };
}

export function intersectWindows(
  a: AvailabilityWindow,
  b: AvailabilityWindow,
): AvailabilityWindow | null {
  const dayStart = a.dayStart > b.dayStart ? a.dayStart : b.dayStart;
  const dayEnd = a.dayEnd < b.dayEnd ? a.dayEnd : b.dayEnd;
  if (dayStart >= dayEnd) return null;
  return { dayStart, dayEnd };
}

export function buildSlotsForWindow(input: {
  window: AvailabilityWindow;
  serviceDurationMin: number;
  bufferAfterMin: number;
  intervalMin?: number;
  blocked: BlockedInterval[];
}): Slot[] {
  const intervalMin = input.intervalMin ?? SLOT_INTERVAL_MIN;
  if (!Number.isInteger(intervalMin) || intervalMin <= 0) {
    throw new Error(
      `intervalMin must be a positive integer number of minutes, received ${String(
        input.intervalMin,
      )}.`,
    );
  }
  const slots: Slot[] = [];
  const durationWithBuffer = input.serviceDurationMin + input.bufferAfterMin;
  let cursor = new Date(input.window.dayStart);
  while (cursor < input.window.dayEnd) {
    const endsAt = addMinutes(cursor, input.serviceDurationMin);
    const blockedEndsAt = addMinutes(cursor, durationWithBuffer);
    if (blockedEndsAt > input.window.dayEnd) break;
    const overlaps = input.blocked.some((blocked) =>
      areIntervalsOverlapping(
        { start: cursor, end: blockedEndsAt },
        { start: blocked.startsAt, end: blocked.endsAt },
        { inclusive: true },
      ),
    );
    if (!overlaps) slots.push({ startsAt: new Date(cursor), endsAt });
    cursor = addMinutes(cursor, intervalMin);
  }
  return slots;
}

/**
 * Dedupe by absolute instant, not by wall clock. On the spring forward day two distinct
 * local start times collapse onto the same instant, and two staff rules that differ only
 * inside the skipped hour would otherwise offer the customer the same moment twice.
 */
export function mergeUniqueSlots(slots: Slot[]): Slot[] {
  const seen = new Set<string>();
  return slots
    .filter((slot) => {
      const key = slot.startsAt.toISOString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
