import { afterEach, describe, expect, it } from "vitest";

import {
  SLOT_INTERVAL_MIN,
  buildSalonWindow,
  buildSlotsForWindow,
  intersectWindows,
  mergeUniqueSlots,
  type BlockedInterval,
} from "./availability-engine";
import { parseSalonDay } from "./time";

const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland"];
const originalHostZone = process.env.TZ;

const OPEN_MIN = 8 * 60;
const CLOSE_MIN = 17 * 60;

function withHostTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  return run();
}

function iso(slots: { startsAt: Date }[]): string[] {
  return slots.map((slot) => slot.startsAt.toISOString());
}

function slotsForDay(dayKey: string, options?: { blocked?: BlockedInterval[] }) {
  return buildSlotsForWindow({
    window: buildSalonWindow(parseSalonDay(dayKey), OPEN_MIN, CLOSE_MIN),
    serviceDurationMin: 60,
    bufferAfterMin: 15,
    blocked: options?.blocked ?? [],
  });
}

afterEach(() => {
  if (originalHostZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostZone;
});

describe("SLOT_INTERVAL_MIN", () => {
  it("is the quarter hour grid the salon books on", () => {
    expect(SLOT_INTERVAL_MIN).toBe(15);
  });

  it("is the default step of buildSlotsForWindow", () => {
    const explicit = slotsForDay("2026-08-04");
    const withInterval = buildSlotsForWindow({
      window: buildSalonWindow(parseSalonDay("2026-08-04"), OPEN_MIN, CLOSE_MIN),
      serviceDurationMin: 60,
      bufferAfterMin: 15,
      intervalMin: SLOT_INTERVAL_MIN,
      blocked: [],
    });
    expect(iso(explicit)).toEqual(iso(withInterval));
    const gaps = explicit
      .slice(1)
      .map((slot, index) => slot.startsAt.getTime() - explicit[index]!.startsAt.getTime());
    expect(new Set(gaps)).toEqual(new Set([SLOT_INTERVAL_MIN * 60_000]));
  });

  it("rejects a step that would never terminate", () => {
    const window = buildSalonWindow(parseSalonDay("2026-08-04"), OPEN_MIN, CLOSE_MIN);
    for (const intervalMin of [0, -15, 7.5, Number.NaN]) {
      expect(() =>
        buildSlotsForWindow({
          window,
          serviceDurationMin: 60,
          bufferAfterMin: 15,
          intervalMin,
          blocked: [],
        }),
      ).toThrow(/positive integer/);
    }
  });
});

describe("buildSalonWindow", () => {
  it("regression: 08:00-17:00 is 06:00Z-15:00Z in August on every host timezone", () => {
    for (const hostZone of HOST_ZONES) {
      const window = withHostTimeZone(hostZone, () =>
        buildSalonWindow(parseSalonDay("2026-08-04"), OPEN_MIN, CLOSE_MIN),
      );
      expect(window.dayStart.toISOString()).toBe("2026-08-04T06:00:00.000Z");
      expect(window.dayEnd.toISOString()).toBe("2026-08-04T15:00:00.000Z");
    }
  });

  it("regression: 08:00-17:00 is 07:00Z-16:00Z in January on every host timezone", () => {
    for (const hostZone of HOST_ZONES) {
      const window = withHostTimeZone(hostZone, () =>
        buildSalonWindow(parseSalonDay("2026-01-13"), OPEN_MIN, CLOSE_MIN),
      );
      expect(window.dayStart.toISOString()).toBe("2026-01-13T07:00:00.000Z");
      expect(window.dayEnd.toISOString()).toBe("2026-01-13T16:00:00.000Z");
    }
  });

  it("accepts an explicit time zone override", () => {
    const window = buildSalonWindow(parseSalonDay("2026-08-04", "UTC"), OPEN_MIN, CLOSE_MIN, "UTC");
    expect(window.dayStart.toISOString()).toBe("2026-08-04T08:00:00.000Z");
    expect(window.dayEnd.toISOString()).toBe("2026-08-04T17:00:00.000Z");
  });

  it("resolves both bounds against the salon day, not the host day", () => {
    const lateEveningUtc = new Date("2026-08-03T22:30:00.000Z");
    const window = buildSalonWindow(lateEveningUtc, OPEN_MIN, CLOSE_MIN);
    expect(window.dayStart.toISOString()).toBe("2026-08-04T06:00:00.000Z");
  });
});

describe("intersectWindows", () => {
  const business = buildSalonWindow(parseSalonDay("2026-08-04"), OPEN_MIN, CLOSE_MIN);

  it("narrows to the tighter of the two windows", () => {
    const staff = buildSalonWindow(parseSalonDay("2026-08-04"), 10 * 60, 14 * 60);
    const window = intersectWindows(business, staff);
    expect(window?.dayStart.toISOString()).toBe("2026-08-04T08:00:00.000Z");
    expect(window?.dayEnd.toISOString()).toBe("2026-08-04T12:00:00.000Z");
  });

  it("returns null when the windows only touch or do not meet at all", () => {
    const touching = buildSalonWindow(parseSalonDay("2026-08-04"), CLOSE_MIN, CLOSE_MIN + 60);
    const disjoint = buildSalonWindow(parseSalonDay("2026-08-04"), 19 * 60, 21 * 60);
    expect(intersectWindows(business, touching)).toBeNull();
    expect(intersectWindows(business, disjoint)).toBeNull();
  });
});

describe("buildSlotsForWindow", () => {
  it("regression: the first bookable instant is 06:00Z in August whatever the host is", () => {
    for (const hostZone of HOST_ZONES) {
      const slots = withHostTimeZone(hostZone, () => slotsForDay("2026-08-04"));
      expect(slots[0]?.startsAt.toISOString()).toBe("2026-08-04T06:00:00.000Z");
      expect(slots[0]?.endsAt.toISOString()).toBe("2026-08-04T07:00:00.000Z");
    }
  });

  it("regression: the first bookable instant is 07:00Z in January whatever the host is", () => {
    for (const hostZone of HOST_ZONES) {
      const slots = withHostTimeZone(hostZone, () => slotsForDay("2026-01-13"));
      expect(slots[0]?.startsAt.toISOString()).toBe("2026-01-13T07:00:00.000Z");
    }
  });

  it("produces an identical slot list on every host timezone", () => {
    const byHost = HOST_ZONES.map((hostZone) =>
      withHostTimeZone(hostZone, () => iso(slotsForDay("2026-08-04")).join("|")),
    );
    expect(new Set(byHost).size).toBe(1);
  });

  it("stops early enough that the buffer still fits before closing time", () => {
    const slots = slotsForDay("2026-08-04");
    const last = slots.at(-1);
    expect(last?.startsAt.toISOString()).toBe("2026-08-04T13:45:00.000Z");
    expect(last?.endsAt.toISOString()).toBe("2026-08-04T14:45:00.000Z");
    expect(slots).toHaveLength(32);
    expect(iso(slots)).not.toContain("2026-08-04T14:00:00.000Z");
  });

  it("skips the blocked intervals and keeps the rest", () => {
    const slots = slotsForDay("2026-08-04", {
      blocked: [
        {
          startsAt: new Date("2026-08-04T08:00:00.000Z"),
          endsAt: new Date("2026-08-04T09:00:00.000Z"),
        },
      ],
    });
    expect(iso(slots)).not.toContain("2026-08-04T07:30:00.000Z");
    expect(iso(slots)).not.toContain("2026-08-04T08:45:00.000Z");
    expect(iso(slots)).toContain("2026-08-04T06:00:00.000Z");
    expect(iso(slots)).toContain("2026-08-04T09:15:00.000Z");
  });

  it("treats a block that only touches the slot boundary as an overlap", () => {
    const slots = slotsForDay("2026-08-04", {
      blocked: [
        {
          startsAt: new Date("2026-08-04T08:00:00.000Z"),
          endsAt: new Date("2026-08-04T09:00:00.000Z"),
        },
      ],
    });
    expect(iso(slots)).not.toContain("2026-08-04T09:00:00.000Z");
    expect(iso(slots)).not.toContain("2026-08-04T06:45:00.000Z");
  });
});

describe("DST salon days", () => {
  it("spring forward 2026-03-29: the 23 hour day still opens at 08:00 local", () => {
    const window = buildSalonWindow(parseSalonDay("2026-03-29"), OPEN_MIN, CLOSE_MIN);
    expect(window.dayStart.toISOString()).toBe("2026-03-29T06:00:00.000Z");
    expect(window.dayEnd.toISOString()).toBe("2026-03-29T15:00:00.000Z");
    const slots = slotsForDay("2026-03-29");
    expect(slots[0]?.startsAt.toISOString()).toBe("2026-03-29T06:00:00.000Z");
    expect(slots).toHaveLength(32);
  });

  it("spring forward 2026-03-29: a window across the gap is one hour shorter in absolute time", () => {
    const day = parseSalonDay("2026-03-29");
    const window = buildSalonWindow(day, 0, 6 * 60);
    expect(window.dayStart.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(window.dayEnd.toISOString()).toBe("2026-03-29T04:00:00.000Z");
    expect(window.dayEnd.getTime() - window.dayStart.getTime()).toBe(5 * 60 * 60 * 1000);
    const slots = buildSlotsForWindow({
      window,
      serviceDurationMin: 60,
      bufferAfterMin: 15,
      blocked: [],
    });
    expect(slots[0]?.startsAt.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(slots.at(-1)?.startsAt.toISOString()).toBe("2026-03-29T02:45:00.000Z");
    expect(slots).toHaveLength(16);
  });

  it("fall back 2026-10-25: the 25 hour day still opens at 08:00 local", () => {
    const window = buildSalonWindow(parseSalonDay("2026-10-25"), OPEN_MIN, CLOSE_MIN);
    expect(window.dayStart.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    expect(window.dayEnd.toISOString()).toBe("2026-10-25T16:00:00.000Z");
    const slots = slotsForDay("2026-10-25");
    expect(slots[0]?.startsAt.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    expect(slots).toHaveLength(32);
  });

  it("fall back 2026-10-25: a window across the repeated hour is one hour longer", () => {
    const day = parseSalonDay("2026-10-25");
    const window = buildSalonWindow(day, 0, 6 * 60);
    expect(window.dayStart.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(window.dayEnd.toISOString()).toBe("2026-10-25T05:00:00.000Z");
    expect(window.dayEnd.getTime() - window.dayStart.getTime()).toBe(7 * 60 * 60 * 1000);
    const slots = buildSlotsForWindow({
      window,
      serviceDurationMin: 60,
      bufferAfterMin: 15,
      blocked: [],
    });
    expect(slots.at(-1)?.startsAt.toISOString()).toBe("2026-10-25T03:45:00.000Z");
    expect(slots).toHaveLength(24);
  });

  it("keeps the opening slot at 08:00 local on every day of the year", () => {
    const days = ["2026-01-13", "2026-03-28", "2026-03-29", "2026-06-21", "2026-10-25"];
    for (const dayKey of days) {
      const first = slotsForDay(dayKey)[0];
      expect(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Rome",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(first?.startsAt),
      ).toBe("08:00");
    }
  });
});

describe("mergeUniqueSlots", () => {
  it("dedupes by instant and sorts ascending", () => {
    const merged = mergeUniqueSlots([
      {
        startsAt: new Date("2026-08-04T09:00:00.000Z"),
        endsAt: new Date("2026-08-04T10:00:00.000Z"),
      },
      {
        startsAt: new Date("2026-08-04T06:00:00.000Z"),
        endsAt: new Date("2026-08-04T07:00:00.000Z"),
      },
      {
        startsAt: new Date("2026-08-04T09:00:00.000Z"),
        endsAt: new Date("2026-08-04T10:00:00.000Z"),
      },
    ]);
    expect(iso(merged)).toEqual(["2026-08-04T06:00:00.000Z", "2026-08-04T09:00:00.000Z"]);
  });

  it("collapses two distinct local start times that fall in the spring forward gap", () => {
    const day = parseSalonDay("2026-03-29");
    const skipped = buildSalonWindow(day, 150, 210).dayStart;
    const shifted = buildSalonWindow(day, 210, 270).dayStart;
    expect(skipped.toISOString()).toBe(shifted.toISOString());
    const merged = mergeUniqueSlots([
      { startsAt: skipped, endsAt: new Date(skipped.getTime() + 60 * 60_000) },
      { startsAt: shifted, endsAt: new Date(shifted.getTime() + 60 * 60_000) },
    ]);
    expect(merged).toHaveLength(1);
  });
});
