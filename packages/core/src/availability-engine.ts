import { addMinutes, areIntervalsOverlapping } from "date-fns";

export type Slot = { startsAt: Date; endsAt: Date };

export type AvailabilityWindow = {
  dayStart: Date;
  dayEnd: Date;
};

export type BlockedInterval = {
  startsAt: Date;
  endsAt: Date;
};

export function minutesToDate(day: Date, minutes: number): Date {
  const result = new Date(day);
  result.setHours(0, 0, 0, 0);
  result.setMinutes(minutes);
  return result;
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
  intervalMin: number;
  blocked: BlockedInterval[];
}): Slot[] {
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
    cursor = addMinutes(cursor, input.intervalMin);
  }
  return slots;
}

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

export function slotOverlapsBlocked(
  slot: Slot,
  blocked: BlockedInterval[],
  bufferAfterMin: number,
): boolean {
  const blockedEnd = addMinutes(
    slot.startsAt,
    slot.endsAt.getTime() - slot.startsAt.getTime() + bufferAfterMin,
  );
  return blocked.some((entry) =>
    areIntervalsOverlapping(
      { start: slot.startsAt, end: blockedEnd },
      { start: entry.startsAt, end: entry.endsAt },
      { inclusive: true },
    ),
  );
}
