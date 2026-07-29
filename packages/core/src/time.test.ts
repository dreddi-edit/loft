import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SALON_TIME_ZONE,
  endOfSalonDay,
  formatInSalonZone,
  formatSalonTimeRange,
  isValidTimeZone,
  parseSalonDay,
  salonDayKey,
  salonDayOfWeek,
  startOfSalonDay,
  zonedMinutesToUtc,
} from "./time";

const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland", "America/Los_Angeles"];
const originalHostZone = process.env.TZ;

function withHostTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  return run();
}

function normalize(value: string): string {
  return value.replace(/[\u202f\u00a0]/g, " ");
}

function legacyMinutesToDate(day: Date, minutes: number): Date {
  const result = new Date(day);
  result.setHours(0, 0, 0, 0);
  result.setMinutes(minutes);
  return result;
}

afterEach(() => {
  if (originalHostZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostZone;
});

describe("SALON_TIME_ZONE", () => {
  it("defaults to Europe/Rome", () => {
    expect(SALON_TIME_ZONE).toBe("Europe/Rome");
  });

  it("is read from the environment when set", async () => {
    vi.resetModules();
    vi.stubEnv("SALON_TIME_ZONE", "America/New_York");
    try {
      const reloaded = await import("./time");
      expect(reloaded.SALON_TIME_ZONE).toBe("America/New_York");
      expect(
        reloaded.zonedMinutesToUtc(new Date("2026-08-04T12:00:00.000Z"), 480).toISOString(),
      ).toBe("2026-08-04T12:00:00.000Z");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("throws at module load when the configured zone is not a real IANA zone", async () => {
    vi.resetModules();
    vi.stubEnv("SALON_TIME_ZONE", "Europe/Brixen");
    try {
      await expect(import("./time")).rejects.toThrow(/Invalid SALON_TIME_ZONE "Europe\/Brixen"/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("Europe/Rome")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  it("rejects nonsense and empty input", () => {
    expect(isValidTimeZone("Europe/Brixen")).toBe(false);
    expect(isValidTimeZone("not a zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
  });
});

describe("zonedMinutesToUtc", () => {
  it("regression: 480 minutes on 2026-08-04 is 06:00Z on every host timezone", () => {
    for (const hostZone of HOST_ZONES) {
      const result = withHostTimeZone(hostZone, () =>
        zonedMinutesToUtc(new Date("2026-08-04T00:00:00.000Z"), 480),
      );
      expect(result.toISOString()).toBe("2026-08-04T06:00:00.000Z");
    }
  });

  it("documents the bug it replaces: the host-local conversion drifts, this one does not", () => {
    const day = new Date("2026-08-04T00:00:00.000Z");
    const legacy = HOST_ZONES.map((hostZone) =>
      withHostTimeZone(hostZone, () => legacyMinutesToDate(day, 480).toISOString()),
    );
    const fixed = HOST_ZONES.map((hostZone) =>
      withHostTimeZone(hostZone, () => zonedMinutesToUtc(day, 480).toISOString()),
    );
    expect(new Set(legacy).size).toBeGreaterThan(1);
    expect(new Set(fixed).size).toBe(1);
    expect(fixed[0]).toBe("2026-08-04T06:00:00.000Z");
  });

  it("converts summer wall clock at CEST (UTC+2)", () => {
    const day = new Date("2026-08-04T00:00:00.000Z");
    expect(zonedMinutesToUtc(day, 0).toISOString()).toBe("2026-08-03T22:00:00.000Z");
    expect(zonedMinutesToUtc(day, 480).toISOString()).toBe("2026-08-04T06:00:00.000Z");
    expect(zonedMinutesToUtc(day, 555).toISOString()).toBe("2026-08-04T07:15:00.000Z");
    expect(zonedMinutesToUtc(day, 1080).toISOString()).toBe("2026-08-04T16:00:00.000Z");
  });

  it("converts winter wall clock at CET (UTC+1)", () => {
    const day = new Date("2026-01-15T00:00:00.000Z");
    expect(zonedMinutesToUtc(day, 0).toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(zonedMinutesToUtc(day, 480).toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(zonedMinutesToUtc(day, 1080).toISOString()).toBe("2026-01-15T17:00:00.000Z");
  });

  it("resolves the calendar day in the salon zone, not on the host", () => {
    const lateEveningUtc = new Date("2026-08-03T22:30:00.000Z");
    expect(zonedMinutesToUtc(lateEveningUtc, 480).toISOString()).toBe("2026-08-04T06:00:00.000Z");
  });

  it("accepts an explicit override zone", () => {
    const day = new Date("2026-08-04T12:00:00.000Z");
    expect(zonedMinutesToUtc(day, 480, "UTC").toISOString()).toBe("2026-08-04T08:00:00.000Z");
    expect(zonedMinutesToUtc(day, 480, "America/New_York").toISOString()).toBe(
      "2026-08-04T12:00:00.000Z",
    );
  });

  it("resolves the calendar day inside the target zone, not inside Europe/Rome", () => {
    const midnightUtc = new Date("2026-08-04T00:00:00.000Z");
    expect(salonDayKey(midnightUtc, "America/New_York")).toBe("2026-08-03");
    expect(zonedMinutesToUtc(midnightUtc, 480, "America/New_York").toISOString()).toBe(
      "2026-08-03T12:00:00.000Z",
    );
  });

  it("rolls minutes outside a day into the adjacent salon day", () => {
    const day = new Date("2026-08-04T00:00:00.000Z");
    expect(zonedMinutesToUtc(day, 1440).toISOString()).toBe("2026-08-04T22:00:00.000Z");
    expect(zonedMinutesToUtc(day, -60).toISOString()).toBe("2026-08-03T21:00:00.000Z");
  });

  it("rejects invalid arguments", () => {
    const day = new Date("2026-08-04T00:00:00.000Z");
    expect(() => zonedMinutesToUtc(new Date("nope"), 480)).toThrow(/valid Date/);
    expect(() => zonedMinutesToUtc(day, 8.5)).toThrow(/integer/);
    expect(() => zonedMinutesToUtc(day, Number.NaN)).toThrow(/integer/);
    expect(() => zonedMinutesToUtc(day, 480, "Europe/Brixen")).toThrow(/Unknown IANA time zone/);
  });
});

describe("DST transitions for Europe/Rome", () => {
  it("spring forward 2026-03-29: 01:59 is CET, 03:00 is CEST", () => {
    const day = new Date("2026-03-29T12:00:00.000Z");
    expect(zonedMinutesToUtc(day, 90).toISOString()).toBe("2026-03-29T00:30:00.000Z");
    expect(zonedMinutesToUtc(day, 119).toISOString()).toBe("2026-03-29T00:59:00.000Z");
    expect(zonedMinutesToUtc(day, 180).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(zonedMinutesToUtc(day, 210).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedMinutesToUtc(day, 480).toISOString()).toBe("2026-03-29T06:00:00.000Z");
  });

  it("spring forward 2026-03-29: the nonexistent 02:00-03:00 hour shifts forward by the gap", () => {
    const day = new Date("2026-03-29T12:00:00.000Z");
    const nonexistent = zonedMinutesToUtc(day, 150);
    expect(nonexistent.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(formatInSalonZone(nonexistent, "en", { hour: "2-digit", minute: "2-digit" })).toBe(
      "03:30",
    );
    expect(zonedMinutesToUtc(day, 120).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(salonDayKey(nonexistent)).toBe("2026-03-29");
  });

  it("spring forward 2026-03-29: the salon day is 23 hours long", () => {
    const day = new Date("2026-03-29T12:00:00.000Z");
    const start = startOfSalonDay(day);
    const end = endOfSalonDay(day);
    expect(start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("fall back 2026-10-25: the doubled 02:00-03:00 hour resolves to the FIRST occurrence", () => {
    const day = new Date("2026-10-25T12:00:00.000Z");
    const ambiguous = zonedMinutesToUtc(day, 150);
    expect(ambiguous.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(ambiguous.toISOString()).not.toBe("2026-10-25T01:30:00.000Z");
    expect(zonedMinutesToUtc(day, 120).toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(formatInSalonZone(ambiguous, "en", { hour: "2-digit", minute: "2-digit" })).toBe(
      "02:30",
    );
  });

  it("fall back 2026-10-25: 01:30 is CEST and 03:30 is CET", () => {
    const day = new Date("2026-10-25T12:00:00.000Z");
    expect(zonedMinutesToUtc(day, 90).toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(zonedMinutesToUtc(day, 210).toISOString()).toBe("2026-10-25T02:30:00.000Z");
    expect(zonedMinutesToUtc(day, 480).toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });

  it("fall back 2026-10-25: the salon day is 25 hours long", () => {
    const day = new Date("2026-10-25T12:00:00.000Z");
    const start = startOfSalonDay(day);
    const end = endOfSalonDay(day);
    expect(start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("keeps 08:00 business hours at 08:00 local across the whole year", () => {
    const days = [
      "2026-01-15",
      "2026-03-28",
      "2026-03-29",
      "2026-06-21",
      "2026-10-25",
      "2026-12-24",
    ];
    for (const key of days) {
      const opening = zonedMinutesToUtc(parseSalonDay(key), 480);
      expect(formatInSalonZone(opening, "en", { hour: "2-digit", minute: "2-digit" })).toBe(
        "08:00",
      );
      expect(salonDayKey(opening)).toBe(key);
    }
  });
});

describe("salonDayOfWeek", () => {
  it("uses the salon day when the host UTC day is still the previous one", () => {
    const justAfterLocalMidnight = new Date("2026-08-03T22:30:00.000Z");
    expect(justAfterLocalMidnight.getUTCDay()).toBe(1);
    expect(salonDayOfWeek(justAfterLocalMidnight)).toBe(2);
  });

  it("uses the salon day when the host UTC day is still the previous one in winter", () => {
    const justAfterLocalMidnight = new Date("2026-01-14T23:30:00.000Z");
    expect(justAfterLocalMidnight.getUTCDay()).toBe(3);
    expect(salonDayOfWeek(justAfterLocalMidnight)).toBe(4);
  });

  it("stays on the current salon day just before local midnight", () => {
    const justBeforeLocalMidnight = new Date("2026-08-04T21:30:00.000Z");
    expect(salonDayOfWeek(justBeforeLocalMidnight)).toBe(2);
    expect(salonDayOfWeek(new Date("2026-08-04T22:30:00.000Z"))).toBe(3);
  });

  it("is independent of the host timezone", () => {
    const instant = new Date("2026-08-03T22:30:00.000Z");
    for (const hostZone of HOST_ZONES) {
      expect(withHostTimeZone(hostZone, () => salonDayOfWeek(instant))).toBe(2);
    }
  });

  it("honours an explicit zone", () => {
    const instant = new Date("2026-08-03T22:30:00.000Z");
    expect(salonDayOfWeek(instant, "UTC")).toBe(1);
  });
});

describe("startOfSalonDay / endOfSalonDay", () => {
  it("returns the local day boundaries as UTC instants in summer", () => {
    const instant = new Date("2026-08-04T14:23:45.678Z");
    expect(startOfSalonDay(instant).toISOString()).toBe("2026-08-03T22:00:00.000Z");
    expect(endOfSalonDay(instant).toISOString()).toBe("2026-08-04T22:00:00.000Z");
  });

  it("returns the local day boundaries as UTC instants in winter", () => {
    const instant = new Date("2026-01-15T14:23:45.678Z");
    expect(startOfSalonDay(instant).toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(endOfSalonDay(instant).toISOString()).toBe("2026-01-15T23:00:00.000Z");
  });

  it("brackets the instant it was derived from", () => {
    for (const iso of ["2026-08-03T22:00:00.000Z", "2026-08-04T21:59:59.999Z"]) {
      const instant = new Date(iso);
      expect(startOfSalonDay(instant).getTime()).toBeLessThanOrEqual(instant.getTime());
      expect(endOfSalonDay(instant).getTime()).toBeGreaterThan(instant.getTime());
      expect(salonDayKey(instant)).toBe("2026-08-04");
    }
  });
});

describe("salonDayKey and parseSalonDay", () => {
  it("keys by the salon day, not the UTC day", () => {
    expect(salonDayKey(new Date("2026-08-03T22:30:00.000Z"))).toBe("2026-08-04");
    expect(salonDayKey(new Date("2026-08-04T21:59:59.999Z"))).toBe("2026-08-04");
    expect(salonDayKey(new Date("2026-08-04T22:00:00.000Z"))).toBe("2026-08-05");
    expect(salonDayKey(new Date("2026-01-14T23:30:00.000Z"))).toBe("2026-01-15");
  });

  it("is independent of the host timezone", () => {
    const instant = new Date("2026-08-03T22:30:00.000Z");
    for (const hostZone of HOST_ZONES) {
      expect(withHostTimeZone(hostZone, () => salonDayKey(instant))).toBe("2026-08-04");
    }
  });

  it("parses a day key to the salon midnight", () => {
    expect(parseSalonDay("2026-08-04").toISOString()).toBe("2026-08-03T22:00:00.000Z");
    expect(parseSalonDay("2026-01-15").toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(parseSalonDay("2026-03-29").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(parseSalonDay("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });

  it("round-trips parseSalonDay -> salonDayKey", () => {
    const keys = [
      "2026-01-01",
      "2026-01-15",
      "2026-02-28",
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-06-21",
      "2026-08-04",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-12-31",
      "2028-02-29",
    ];
    for (const key of keys) {
      expect(salonDayKey(parseSalonDay(key))).toBe(key);
    }
  });

  it("round-trips salonDayKey -> parseSalonDay -> salonDayKey across a full year", () => {
    let cursor = new Date("2026-01-01T12:00:00.000Z");
    for (let index = 0; index < 365; index += 1) {
      const key = salonDayKey(cursor);
      expect(salonDayKey(parseSalonDay(key))).toBe(key);
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  });

  it("rejects malformed day keys", () => {
    expect(() => parseSalonDay("2026-8-4")).toThrow(/YYYY-MM-DD/);
    expect(() => parseSalonDay("04.08.2026")).toThrow(/YYYY-MM-DD/);
    expect(() => parseSalonDay("2026-08-04T00:00:00Z")).toThrow(/YYYY-MM-DD/);
    expect(() => parseSalonDay("")).toThrow(/YYYY-MM-DD/);
  });

  it("rejects calendar dates that do not exist", () => {
    expect(() => parseSalonDay("2026-02-30")).toThrow(/No such calendar date/);
    expect(() => parseSalonDay("2026-13-01")).toThrow(/No such calendar date/);
    expect(() => parseSalonDay("2026-00-10")).toThrow(/No such calendar date/);
    expect(() => parseSalonDay("2027-02-29")).toThrow(/No such calendar date/);
  });
});

describe("formatInSalonZone", () => {
  const appointment = new Date("2026-08-04T06:00:00.000Z");

  it("renders the salon wall clock for every app locale", () => {
    expect(normalize(formatInSalonZone(appointment, "de"))).toBe(
      "Dienstag, 4. August 2026 um 08:00",
    );
    expect(normalize(formatInSalonZone(appointment, "it"))).toBe(
      "martedì 4 agosto 2026 alle ore 08:00",
    );
    expect(normalize(formatInSalonZone(appointment, "fr"))).toBe("mardi 4 août 2026 à 08:00");
    expect(normalize(formatInSalonZone(appointment, "en"))).toBe("Tuesday, 4 August 2026 at 08:00");
  });

  it("produces the same output regardless of process.env.TZ", () => {
    for (const hostZone of HOST_ZONES) {
      const rendered = withHostTimeZone(hostZone, () =>
        normalize(formatInSalonZone(appointment, "de")),
      );
      expect(rendered).toBe("Dienstag, 4. August 2026 um 08:00");
    }
  });

  it("is not what toLocaleString does, which is the bug being fixed", () => {
    const naive = HOST_ZONES.map((hostZone) =>
      withHostTimeZone(hostZone, () => normalize(appointment.toLocaleString("de"))),
    );
    const fixed = HOST_ZONES.map((hostZone) =>
      withHostTimeZone(hostZone, () => normalize(formatInSalonZone(appointment, "de"))),
    );
    expect(new Set(naive).size).toBeGreaterThan(1);
    expect(new Set(fixed).size).toBe(1);
  });

  it("renders the winter offset correctly", () => {
    const winter = new Date("2026-01-15T07:00:00.000Z");
    expect(normalize(formatInSalonZone(winter, "de"))).toBe("Donnerstag, 15. Jänner 2026 um 08:00");
  });

  it("uses the South Tyrolean/Austrian German month names de-IT implies, not de-DE ones", () => {
    const winter = new Date("2026-01-15T07:00:00.000Z");
    expect(normalize(formatInSalonZone(winter, "de"))).toContain("Jänner");
    expect(normalize(formatInSalonZone(winter, "de"))).not.toContain("Januar");
  });

  it("honours caller supplied options and still forces the salon zone", () => {
    expect(formatInSalonZone(appointment, "en", { hour: "2-digit", minute: "2-digit" })).toBe(
      "08:00",
    );
    expect(
      formatInSalonZone(appointment, "en", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Pacific/Auckland",
      }),
    ).toBe("08:00");
    expect(formatInSalonZone(appointment, "en", { dateStyle: "short" })).toBe("04/08/2026");
  });

  it("normalises locale variants and falls back for unknown locales", () => {
    expect(normalize(formatInSalonZone(appointment, "de-DE"))).toBe(
      normalize(formatInSalonZone(appointment, "de")),
    );
    expect(normalize(formatInSalonZone(appointment, "DE"))).toBe(
      normalize(formatInSalonZone(appointment, "de")),
    );
    expect(normalize(formatInSalonZone(appointment, "es"))).toBe(
      normalize(formatInSalonZone(appointment, "en")),
    );
  });

  it("rejects invalid instants", () => {
    expect(() => formatInSalonZone(new Date("nope"), "de")).toThrow(/valid Date/);
  });
});

describe("formatSalonTimeRange", () => {
  const start = new Date("2026-08-04T06:00:00.000Z");
  const end = new Date("2026-08-04T07:15:00.000Z");

  it("renders a salon zone range per locale", () => {
    expect(normalize(formatSalonTimeRange(start, end, "de"))).toBe(
      "Di., 4. Aug. 2026, 08:00-09:15",
    );
    expect(normalize(formatSalonTimeRange(start, end, "it"))).toBe("mar 4 ago 2026, 08:00-09:15");
    expect(normalize(formatSalonTimeRange(start, end, "fr"))).toBe("mar. 4 août 2026, 08:00-09:15");
    expect(normalize(formatSalonTimeRange(start, end, "en"))).toBe("Tue, 4 Aug 2026, 08:00-09:15");
  });

  it("is independent of the host timezone", () => {
    for (const hostZone of HOST_ZONES) {
      expect(
        withHostTimeZone(hostZone, () => normalize(formatSalonTimeRange(start, end, "de"))),
      ).toBe("Di., 4. Aug. 2026, 08:00-09:15");
    }
  });

  it("uses a 24 hour clock in winter too", () => {
    expect(
      normalize(
        formatSalonTimeRange(
          new Date("2026-01-15T16:30:00.000Z"),
          new Date("2026-01-15T17:00:00.000Z"),
          "de",
        ),
      ),
    ).toBe("Do., 15. Jän. 2026, 17:30-18:00");
  });

  it("repeats the date when the range crosses local midnight", () => {
    expect(
      normalize(
        formatSalonTimeRange(
          new Date("2026-08-04T21:30:00.000Z"),
          new Date("2026-08-04T22:30:00.000Z"),
          "en",
        ),
      ),
    ).toBe("Tue, 4 Aug 2026, 23:30 - Wed, 5 Aug 2026, 00:30");
  });

  it("rejects invalid instants", () => {
    expect(() => formatSalonTimeRange(new Date("nope"), end, "de")).toThrow(/valid Date/);
    expect(() => formatSalonTimeRange(start, new Date("nope"), "de")).toThrow(/valid Date/);
  });
});
