import { afterEach, describe, expect, it } from "vitest";

import {
  dateTimeLocalToIso,
  formatSalonDate,
  formatSalonDateTime,
  formatSalonDayNumber,
  formatSalonTime,
  formatSalonWeekday,
  fromDateTimeLocalValue,
  salonInstantOnDay,
  salonMinutesFromMidnight,
  salonMonthStartInputValue,
  salonWeekdayNames,
  shiftSalonDayKey,
  toDateInputValue,
  toDateTimeLocalValue,
} from "./admin-datetime";

/**
 * The admin renders on Cloud Run (UTC) and in a browser that can be anywhere, so every
 * assertion below is repeated under host zones on both sides of Europe/Rome. A helper
 * that reads the host clock fails in at least one of them.
 */
const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland", "America/Los_Angeles"];
const originalHostZone = process.env.TZ;

function withHostTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  return run();
}

function normalize(value: string): string {
  return value.replace(/[\u202f\u00a0]/g, " ");
}

afterEach(() => {
  if (originalHostZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostZone;
});

describe("toDateTimeLocalValue", () => {
  it("shows the salon wall clock, not the host wall clock", () => {
    const instant = new Date("2026-08-04T06:00:00.000Z");
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(toDateTimeLocalValue(instant)).toBe("2026-08-04T08:00");
      });
    }
  });

  it("accepts the serialized dates that Next.js hands to client components", () => {
    expect(toDateTimeLocalValue("2026-01-15T09:30:00.000Z")).toBe("2026-01-15T10:30");
    expect(toDateTimeLocalValue(Date.UTC(2026, 0, 15, 9, 30))).toBe("2026-01-15T10:30");
  });

  it("uses CET in winter and CEST in summer", () => {
    expect(toDateTimeLocalValue(new Date("2026-01-04T07:00:00.000Z"))).toBe("2026-01-04T08:00");
    expect(toDateTimeLocalValue(new Date("2026-07-04T06:00:00.000Z"))).toBe("2026-07-04T08:00");
  });

  it("rejects an invalid instant instead of rendering Invalid Date", () => {
    expect(() => toDateTimeLocalValue("not a date")).toThrow(/valid instant/);
  });
});

describe("fromDateTimeLocalValue", () => {
  it("reads the value as salon wall clock whatever the host zone is", () => {
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(fromDateTimeLocalValue("2026-08-04T08:00").toISOString()).toBe(
          "2026-08-04T06:00:00.000Z",
        );
      });
    }
  });

  it("differs from the host-zone reading that new Date(value) would produce", () => {
    withHostTimeZone("UTC", () => {
      const value = "2026-08-04T08:00";
      expect(new Date(value).toISOString()).toBe("2026-08-04T08:00:00.000Z");
      expect(fromDateTimeLocalValue(value).toISOString()).toBe("2026-08-04T06:00:00.000Z");
    });
  });

  it("tolerates the seconds some browsers append", () => {
    expect(fromDateTimeLocalValue("2026-08-04T08:00:00").toISOString()).toBe(
      "2026-08-04T06:00:00.000Z",
    );
  });

  it("rejects malformed and out-of-range values", () => {
    expect(() => fromDateTimeLocalValue("")).toThrow(/Expected format/);
    expect(() => fromDateTimeLocalValue("2026-08-04")).toThrow(/Expected format/);
    expect(() => fromDateTimeLocalValue("04.08.2026 08:00")).toThrow(/Expected format/);
    expect(() => fromDateTimeLocalValue("2026-08-04T25:00")).toThrow(/out of range/);
    expect(() => fromDateTimeLocalValue("2026-08-04T08:75")).toThrow(/out of range/);
    expect(() => fromDateTimeLocalValue("2026-02-30T08:00")).toThrow(/No such calendar date/);
  });
});

describe("datetime-local round trip", () => {
  const MINUTE = 60_000;

  function roundTrip(instant: Date): Date {
    return fromDateTimeLocalValue(toDateTimeLocalValue(instant));
  }

  it("is lossless to the minute on ordinary days in every host zone", () => {
    const instants = [
      new Date("2026-01-15T09:30:00.000Z"),
      new Date("2026-06-30T22:45:00.000Z"),
      new Date("2026-12-31T23:00:00.000Z"),
      new Date("2027-02-28T00:00:00.000Z"),
    ];
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        for (const instant of instants) {
          expect(roundTrip(instant).toISOString()).toBe(instant.toISOString());
        }
      });
    }
  });

  it("is lossless across the spring forward, where 02:00-03:00 local never happens", () => {
    // Europe/Rome moves UTC+1 -> UTC+2 at 2026-03-29T01:00:00Z.
    const transition = new Date("2026-03-29T01:00:00.000Z");
    for (let offset = -180; offset <= 180; offset += 5) {
      const instant = new Date(transition.getTime() + offset * MINUTE);
      for (const zone of HOST_ZONES) {
        withHostTimeZone(zone, () => {
          expect(roundTrip(instant).toISOString()).toBe(instant.toISOString());
        });
      }
    }
  });

  it("keeps the gap on the salon side of the spring forward", () => {
    expect(toDateTimeLocalValue(new Date("2026-03-29T00:59:00.000Z"))).toBe("2026-03-29T01:59");
    expect(toDateTimeLocalValue(new Date("2026-03-29T01:00:00.000Z"))).toBe("2026-03-29T03:00");
  });

  it("resolves a wall clock inside the spring gap forward instead of throwing", () => {
    expect(fromDateTimeLocalValue("2026-03-29T02:30").toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(toDateTimeLocalValue(fromDateTimeLocalValue("2026-03-29T02:30"))).toBe(
      "2026-03-29T03:30",
    );
  });

  it("is lossless across the autumn fall back outside the repeated hour", () => {
    // Europe/Rome moves UTC+2 -> UTC+1 at 2026-10-25T01:00:00Z, so 02:00-03:00 local
    // occurs twice: once at UTC+2 (00:00Z-01:00Z) and once at UTC+1 (01:00Z-02:00Z).
    const instants = [
      new Date("2026-10-24T23:30:00.000Z"),
      new Date("2026-10-25T00:00:00.000Z"),
      new Date("2026-10-25T00:59:00.000Z"),
      new Date("2026-10-25T02:00:00.000Z"),
      new Date("2026-10-25T07:15:00.000Z"),
    ];
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        for (const instant of instants) {
          expect(roundTrip(instant).toISOString()).toBe(instant.toISOString());
        }
      });
    }
  });

  it("collapses the repeated autumn hour onto its first occurrence", () => {
    const first = new Date("2026-10-25T00:30:00.000Z");
    const second = new Date("2026-10-25T01:30:00.000Z");
    expect(toDateTimeLocalValue(first)).toBe("2026-10-25T02:30");
    expect(toDateTimeLocalValue(second)).toBe("2026-10-25T02:30");
    expect(roundTrip(first).toISOString()).toBe(first.toISOString());
    expect(roundTrip(second).toISOString()).toBe(first.toISOString());
  });

  it("moves an appointment by nothing at all, unlike the host-zone round trip", () => {
    withHostTimeZone("UTC", () => {
      const instant = new Date("2026-08-04T06:00:00.000Z");
      const naive = new Date(new Date(instant).toISOString().slice(0, 16));
      expect(naive.getTime() - instant.getTime()).toBe(0);
      expect(new Date(toDateTimeLocalValue(instant)).getTime() - instant.getTime()).toBe(
        2 * 60 * MINUTE,
      );
      expect(roundTrip(instant).getTime() - instant.getTime()).toBe(0);
    });
  });
});

describe("dateTimeLocalToIso", () => {
  it("serialises the salon wall clock for the API", () => {
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(dateTimeLocalToIso("2026-12-24T17:45")).toBe("2026-12-24T16:45:00.000Z");
      });
    }
  });
});

describe("date input helpers", () => {
  it("derives the salon day, not the host day", () => {
    const lateEvening = new Date("2026-07-04T22:30:00.000Z");
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(toDateInputValue(lateEvening)).toBe("2026-07-05");
      });
    }
  });

  it("derives the salon month start from the salon day", () => {
    // 2026-08-01T00:30 local is still 2026-07-31 in UTC.
    const instant = new Date("2026-07-31T22:30:00.000Z");
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(salonMonthStartInputValue(instant)).toBe("2026-08-01");
      });
    }
  });
});

describe("shiftSalonDayKey", () => {
  it("walks whole salon days across both DST transitions", () => {
    expect(shiftSalonDayKey("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftSalonDayKey("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftSalonDayKey("2026-10-24", 1)).toBe("2026-10-25");
    expect(shiftSalonDayKey("2026-10-25", 1)).toBe("2026-10-26");
    expect(shiftSalonDayKey("2026-03-30", -1)).toBe("2026-03-29");
    expect(shiftSalonDayKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftSalonDayKey("2026-03-23", 6)).toBe("2026-03-29");
  });

  it("is independent of the host zone", () => {
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(shiftSalonDayKey("2026-10-25", 7)).toBe("2026-11-01");
      });
    }
  });
});

describe("salonInstantOnDay", () => {
  it("places business minutes on the right instant in summer and winter", () => {
    expect(salonInstantOnDay("2026-08-04", 480).toISOString()).toBe("2026-08-04T06:00:00.000Z");
    expect(salonInstantOnDay("2026-01-04", 480).toISOString()).toBe("2026-01-04T07:00:00.000Z");
  });

  it("preserves the wall clock when a calendar drag moves a day across a DST edge", () => {
    const minutes = salonMinutesFromMidnight(new Date("2026-03-28T09:00:00.000Z"));
    expect(minutes).toBe(600);
    expect(salonInstantOnDay("2026-03-30", minutes).toISOString()).toBe(
      "2026-03-30T08:00:00.000Z",
    );
  });
});

describe("salonMinutesFromMidnight", () => {
  it("reads the salon clock in every host zone", () => {
    const instant = new Date("2026-08-04T06:15:00.000Z");
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(salonMinutesFromMidnight(instant)).toBe(495);
      });
    }
  });

  it("counts wall-clock minutes, not elapsed minutes, on the spring DST day", () => {
    expect(salonMinutesFromMidnight(new Date("2026-03-29T01:30:00.000Z"))).toBe(210);
  });
});

describe("formatters", () => {
  it("render in the salon zone regardless of the host zone", () => {
    const instant = new Date("2026-08-04T21:30:00.000Z");
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(formatSalonDate(instant, "de")).toBe("04.08.2026");
        expect(formatSalonTime(instant, "de")).toBe("23:30");
        expect(formatSalonDayNumber(instant, "de")).toBe("4");
      });
    }
  });

  it("follow the admin locale instead of a hardcoded tag", () => {
    const instant = new Date("2026-08-04T06:00:00.000Z");
    expect(formatSalonDate(instant, "de")).toBe("04.08.2026");
    expect(formatSalonDate(instant, "it")).toBe("04/08/2026");
    expect(formatSalonDate(instant, "fr")).toBe("04/08/2026");
    expect(formatSalonDate(instant, "en")).toBe("04/08/2026");
    expect(formatSalonWeekday(instant, "de")).toBe("Di");
    expect(formatSalonWeekday(instant, "it")).toBe("mar");
    expect(formatSalonWeekday(instant, "en")).toBe("Tue");
  });

  it("uses a 24 hour clock in every locale", () => {
    const instant = new Date("2026-08-04T13:05:00.000Z");
    for (const locale of ["de", "it", "fr", "en"] as const) {
      expect(formatSalonTime(instant, locale)).toBe("15:05");
      expect(normalize(formatSalonDateTime(instant, locale))).toContain("15:05");
    }
  });
});

describe("salonWeekdayNames", () => {
  it("is indexed 0=Sunday..6=Saturday like BusinessHours.dayOfWeek", () => {
    expect(salonWeekdayNames("en")).toEqual([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]);
    expect(salonWeekdayNames("de")[0]).toBe("Sonntag");
    expect(salonWeekdayNames("it")[1]).toBe("lunedì");
    expect(salonWeekdayNames("fr")[6]).toBe("samedi");
    expect(salonWeekdayNames("en", "short")).toEqual([
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ]);
  });

  it("does not drift with the host zone", () => {
    for (const zone of HOST_ZONES) {
      withHostTimeZone(zone, () => {
        expect(salonWeekdayNames("en", "short")[0]).toBe("Sun");
      });
    }
  });
});
