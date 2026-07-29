import { afterEach, describe, expect, it } from "vitest";
import {
  SALON_TIME_ZONE,
  formatSalonClock,
  formatSalonClockWithZone,
  formatSalonDateTime,
  fromSalonWallClock,
  isSalonDayKey,
  isSalonWallClock,
  salonTodayKey,
  toSalonWallClock,
} from "./web-datetime";

const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland", "America/Los_Angeles"];
const LOCALES = ["de", "it", "fr", "en"];
const MS_PER_MINUTE = 60_000;
const originalHostZone = process.env.TZ;

function forEachHostZone(run: () => void): void {
  for (const zone of HOST_ZONES) {
    process.env.TZ = zone;
    run();
  }
}

function normalize(value: string): string {
  return value.replace(/[\u202f\u00a0]/g, " ");
}

afterEach(() => {
  if (originalHostZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostZone;
});

describe("toSalonWallClock", () => {
  it("renders the salon wall clock, not UTC and not the host zone", () => {
    forEachHostZone(() => {
      expect(toSalonWallClock(new Date("2026-08-04T06:00:00.000Z"))).toBe("2026-08-04T08:00");
      expect(toSalonWallClock(new Date("2026-01-15T07:00:00.000Z"))).toBe("2026-01-15T08:00");
    });
  });

  it("rolls over to the next salon day, not the next UTC day", () => {
    forEachHostZone(() => {
      expect(toSalonWallClock(new Date("2026-08-04T22:30:00.000Z"))).toBe("2026-08-05T00:30");
      expect(toSalonWallClock(new Date("2026-08-04T21:30:00.000Z"))).toBe("2026-08-04T23:30");
    });
  });

  it("accepts the ISO strings the API returns", () => {
    expect(toSalonWallClock("2026-08-04T06:00:00.000Z")).toBe("2026-08-04T08:00");
  });

  it("rejects values that are not dates", () => {
    expect(() => toSalonWallClock("")).toThrow(/valid date/);
    expect(() => toSalonWallClock("not-a-date")).toThrow(/valid date/);
  });
});

describe("fromSalonWallClock", () => {
  it("reads the input value as salon wall clock in summer and in winter", () => {
    forEachHostZone(() => {
      expect(fromSalonWallClock("2026-08-04T08:00").toISOString()).toBe("2026-08-04T06:00:00.000Z");
      expect(fromSalonWallClock("2026-01-15T08:00").toISOString()).toBe("2026-01-15T07:00:00.000Z");
    });
  });

  it("accepts the seconds some browsers append", () => {
    expect(fromSalonWallClock("2026-08-04T08:00:00").toISOString()).toBe(
      "2026-08-04T06:00:00.000Z",
    );
  });

  it("rejects malformed and impossible values", () => {
    expect(() => fromSalonWallClock("")).toThrow(/Expected YYYY-MM-DDTHH:mm/);
    expect(() => fromSalonWallClock("2026-08-04")).toThrow(/Expected YYYY-MM-DDTHH:mm/);
    expect(() => fromSalonWallClock("2026-08-04T24:00")).toThrow(/Expected YYYY-MM-DDTHH:mm/);
    expect(() => fromSalonWallClock("2026-08-04T08:60")).toThrow(/Expected YYYY-MM-DDTHH:mm/);
    expect(() => fromSalonWallClock("2026-02-30T08:00")).toThrow(/Expected YYYY-MM-DDTHH:mm/);
  });
});

describe("Europe/Rome spring forward, 2026-03-29", () => {
  it("keeps the hours on either side of the gap on their own offsets", () => {
    forEachHostZone(() => {
      expect(fromSalonWallClock("2026-03-29T01:59").toISOString()).toBe("2026-03-29T00:59:00.000Z");
      expect(fromSalonWallClock("2026-03-29T03:00").toISOString()).toBe("2026-03-29T01:00:00.000Z");
    });
  });

  it("normalises the hour that never happens forward instead of backwards", () => {
    const instant = fromSalonWallClock("2026-03-29T02:30");
    expect(instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(toSalonWallClock(instant)).toBe("2026-03-29T03:30");
  });

  it("round trips every wall clock of the day except the skipped hour", () => {
    forEachHostZone(() => {
      for (let minutes = 0; minutes < 1440; minutes += 15) {
        const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
        const minute = String(minutes % 60).padStart(2, "0");
        const value = `2026-03-29T${hour}:${minute}`;
        const expected = hour === "02" ? `2026-03-29T03:${minute}` : value;
        expect(toSalonWallClock(fromSalonWallClock(value))).toBe(expected);
      }
    });
  });

  it("round trips every instant of the day", () => {
    const dayStart = fromSalonWallClock("2026-03-29T00:00").getTime();
    for (let step = 0; step < 23 * 4; step += 1) {
      const instant = new Date(dayStart + step * 15 * MS_PER_MINUTE);
      expect(fromSalonWallClock(toSalonWallClock(instant)).toISOString()).toBe(
        instant.toISOString(),
      );
    }
  });
});

describe("Europe/Rome fall back, 2026-10-25", () => {
  it("resolves the repeated hour to its first occurrence", () => {
    forEachHostZone(() => {
      expect(fromSalonWallClock("2026-10-25T02:30").toISOString()).toBe("2026-10-25T00:30:00.000Z");
      expect(fromSalonWallClock("2026-10-25T03:30").toISOString()).toBe("2026-10-25T02:30:00.000Z");
    });
  });

  it("renders both occurrences of the repeated hour with the same wall clock", () => {
    expect(toSalonWallClock(new Date("2026-10-25T00:30:00.000Z"))).toBe("2026-10-25T02:30");
    expect(toSalonWallClock(new Date("2026-10-25T01:30:00.000Z"))).toBe("2026-10-25T02:30");
  });

  it("round trips every wall clock of the day", () => {
    forEachHostZone(() => {
      for (let minutes = 0; minutes < 1440; minutes += 15) {
        const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
        const minute = String(minutes % 60).padStart(2, "0");
        const value = `2026-10-25T${hour}:${minute}`;
        expect(toSalonWallClock(fromSalonWallClock(value))).toBe(value);
      }
    });
  });

  it("round trips every instant of the day except the ambiguous hour", () => {
    const dayStart = fromSalonWallClock("2026-10-25T00:00").getTime();
    const ambiguousFrom = Date.parse("2026-10-25T01:00:00.000Z");
    const ambiguousUntil = Date.parse("2026-10-25T02:00:00.000Z");
    for (let step = 0; step < 25 * 4; step += 1) {
      const epoch = dayStart + step * 15 * MS_PER_MINUTE;
      const ambiguous = epoch >= ambiguousFrom && epoch < ambiguousUntil;
      const expected = ambiguous ? epoch - 60 * MS_PER_MINUTE : epoch;
      expect(fromSalonWallClock(toSalonWallClock(new Date(epoch))).getTime()).toBe(expected);
    }
  });
});

describe("salonTodayKey", () => {
  it("is the salon's day, not the UTC day", () => {
    forEachHostZone(() => {
      expect(salonTodayKey(new Date("2026-07-28T23:30:00.000Z"))).toBe("2026-07-29");
      expect(salonTodayKey(new Date("2026-01-15T23:30:00.000Z"))).toBe("2026-01-16");
      expect(salonTodayKey(new Date("2026-07-29T00:30:00.000Z"))).toBe("2026-07-29");
    });
  });
});

describe("day key and wall clock guards", () => {
  it("accepts real calendar values", () => {
    expect(isSalonDayKey("2026-08-04")).toBe(true);
    expect(isSalonDayKey(" 2026-08-04 ")).toBe(true);
    expect(isSalonWallClock("2026-08-04T08:00")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isSalonDayKey("")).toBe(false);
    expect(isSalonDayKey("04.08.2026")).toBe(false);
    expect(isSalonDayKey("2026-13-01")).toBe(false);
    expect(isSalonDayKey("2026-02-30")).toBe(false);
    expect(isSalonDayKey("2026-08-04T08:00")).toBe(false);
    expect(isSalonWallClock("2026-08-04")).toBe(false);
    expect(isSalonWallClock("2026-08-04T99:00")).toBe(false);
  });
});

describe("salon zone rendering", () => {
  it("shows the salon clock in every locale and host zone", () => {
    forEachHostZone(() => {
      for (const locale of LOCALES) {
        expect(formatSalonClock(new Date("2026-08-04T06:00:00.000Z"), locale)).toBe("08:00");
        expect(formatSalonClock("2026-01-15T07:00:00.000Z", locale)).toBe("08:00");
      }
    });
  });

  it("names the zone the time is stated in", () => {
    for (const locale of LOCALES) {
      const summer = normalize(formatSalonClockWithZone("2026-08-04T06:00:00.000Z", locale));
      const winter = normalize(formatSalonClockWithZone("2026-01-15T07:00:00.000Z", locale));
      expect(summer.startsWith("08:00 ")).toBe(true);
      expect(winter.startsWith("08:00 ")).toBe(true);
      expect(summer).not.toBe(winter);
    }
  });

  it("keeps date and time together in one salon-zone string", () => {
    for (const locale of LOCALES) {
      const rendered = normalize(formatSalonDateTime("2026-08-04T06:00:00.000Z", locale));
      expect(rendered).toContain("08:00");
      expect(rendered).toContain("2026");
    }
  });

  it("exposes the zone it renders in", () => {
    expect(SALON_TIME_ZONE).toBe("Europe/Rome");
  });
});
