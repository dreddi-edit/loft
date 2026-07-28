import { addMinutes, areIntervalsOverlapping } from "date-fns";
import { buildAvailabilitySlots, type Slot } from "./index";

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

export function intersectWindows(a: AvailabilityWindow, b: AvailabilityWindow): AvailabilityWindow | null {
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
  return buildAvailabilitySlots({
    serviceDurationMin: input.serviceDurationMin,
    bufferAfterMin: input.bufferAfterMin,
    intervalMin: input.intervalMin,
    dayStart: input.window.dayStart,
    dayEnd: input.window.dayEnd,
    blocked: input.blocked,
  });
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

export function slotOverlapsBlocked(slot: Slot, blocked: BlockedInterval[], bufferAfterMin: number): boolean {
  const blockedEnd = addMinutes(slot.startsAt, slot.endsAt.getTime() - slot.startsAt.getTime() + bufferAfterMin);
  return blocked.some((entry) =>
    areIntervalsOverlapping(
      { start: slot.startsAt, end: blockedEnd },
      { start: entry.startsAt, end: entry.endsAt },
      { inclusive: true },
    ),
  );
}
