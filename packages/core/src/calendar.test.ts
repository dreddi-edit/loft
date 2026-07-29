import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * In-memory Prisma double.
 *
 * Every stored instant is anchored to the suite's own timeline rather than
 * to the epoch, so window filters are exercised against realistic values
 * instead of being trivially satisfied by 1970 timestamps.
 *
 * `select` is honoured rather than ignored, so a service that reads a
 * column it forgot to select gets `null` here just like in Postgres, and
 * `settle()` adds real latency so concurrent reads genuinely interleave.
 * ------------------------------------------------------------------ */

const { db, store } = vi.hoisted(() => {
  const appointments: Row[] = [];
  const staffProfiles: Row[] = [];
  let latency = 0;

  async function settle(): Promise<void> {
    if (latency <= 0) {
      await Promise.resolve();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, latency));
  }

  function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
  }

  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return comparable(actual) === expected.getTime();
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
      return Object.entries(expected as Row).every(([operator, operand]) => {
        const left = comparable(actual) as number;
        const right = comparable(operand) as number;
        if (operator === "lt") return left < right;
        if (operator === "lte") return left <= right;
        if (operator === "gt") return left > right;
        if (operator === "gte") return left >= right;
        if (operator === "not") return left !== right;
        if (operator === "in") return (operand as unknown[]).includes(actual);
        throw new Error(`unsupported operator ${operator}`);
      });
    }
    return actual === expected;
  }

  function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => matchValue(row[key], expected));
  }

  function project(value: unknown, select: Row | undefined): unknown {
    if (value === undefined || value === null) return null;
    if (!select) return value;
    if (Array.isArray(value)) return value.map((entry) => project(entry, select));
    const output: Row = {};
    for (const [key, spec] of Object.entries(select)) {
      const raw = (value as Row)[key];
      if (spec === true) {
        output[key] = raw === undefined ? null : raw;
        continue;
      }
      output[key] = project(raw, (spec as { select?: Row }).select);
    }
    return output;
  }

  function sortAndTake(rows: Row[], args: Row): Row[] {
    const orderBy = args.orderBy as Row | undefined;
    const sorted = [...rows];
    if (orderBy) {
      const [key, direction] = Object.entries(orderBy)[0] as [string, string];
      sorted.sort((left, right) => {
        const a = comparable(left[key]) as number;
        const b = comparable(right[key]) as number;
        return direction === "desc" ? b - a : a - b;
      });
    }
    const take = args.take as number | undefined;
    return take === undefined ? sorted : sorted.slice(0, take);
  }

  const prisma = {
    appointment: {
      findUnique: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        await settle();
        const found = appointments.find((row) => matches(row, where));
        return found ? project(found, select) : null;
      }),
      findMany: vi.fn(async (args: Row = {}) => {
        await settle();
        const filtered = appointments.filter((row) => matches(row, (args.where as Row) ?? {}));
        return sortAndTake(filtered, args).map((row) => project(row, args.select as Row));
      }),
    },
    staffProfile: {
      findUnique: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        await settle();
        const found = staffProfiles.find((row) => matches(row, where));
        return found ? project(found, select) : null;
      }),
    },
  };

  return {
    db: prisma,
    store: {
      appointments,
      staffProfiles,
      reset() {
        appointments.length = 0;
        staffProfiles.length = 0;
        latency = 0;
      },
      setLatency(value: number) {
        latency = value;
      },
    },
  };
});

vi.mock("@hair-simo/db", () => ({

  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({ tenantId_email: { tenantId: "cltenant00000000000000001", email } }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({ tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek } }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },
 prisma: db }));

import {
  DEFAULT_ORGANIZER_EMAIL,
  ICS_CONTENT_TYPE,
  ICS_PRODUCT_ID,
  ICS_UID_DOMAIN,
  STAFF_FEED_TOKEN_VERSION,
  appointmentSequence,
  appointmentUid,
  buildAppointmentIcs,
  buildCancellationIcs,
  buildStaffFeed,
  buildStaffFeedForToken,
  createStaffFeedToken,
  escapeIcsParam,
  escapeIcsText,
  foldIcsLine,
  icsFilename,
  loadAppointmentForIcs,
  loadStaffFeedAppointments,
  staffFeedUrl,
  toIcsAppointment,
  verifyStaffFeedToken,
  type IcsAppointmentInput,
} from "./calendar";

const encoder = new TextEncoder();
const octets = (value: string) => encoder.encode(value).length;

/* ------------------------------------------------------------------ *
 * A deliberately strict, dependency-free iCalendar validator.
 * Everything it rejects is something a real client rejects or silently
 * mis-renders, so every builder output in this file is run through it.
 * ------------------------------------------------------------------ */

type IcsProperty = { name: string; params: Record<string, string>; value: string };
type IcsComponent = { name: string; properties: IcsProperty[]; children: IcsComponent[] };
type IcsDocument = { properties: IcsProperty[]; root: IcsComponent };

const TEXT_PROPERTIES = new Set([
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "COMMENT",
  "TZNAME",
  "NAME",
  "PRODID",
  "X-WR-CALNAME",
  "X-WR-CALDESC",
  "X-WR-TIMEZONE",
  "X-LIC-LOCATION",
]);

const DATE_TIME = /^\d{8}T\d{6}Z?$/;
const PROPERTY_NAME = /^[A-Z][A-Z0-9-]*$/;

function splitProperty(line: string): IcsProperty {
  let index = 0;
  while (index < line.length && /[A-Za-z0-9-]/.test(line[index]!)) index += 1;
  const name = line.slice(0, index);
  if (!name) throw new Error(`property has no name: ${line}`);
  if (!PROPERTY_NAME.test(name)) throw new Error(`property name is not upper-case: ${name}`);

  const params: Record<string, string> = {};
  while (line[index] === ";") {
    index += 1;
    const start = index;
    let quoted = false;
    while (index < line.length) {
      const char = line[index]!;
      if (char === '"') quoted = !quoted;
      else if (!quoted && (char === ";" || char === ":")) break;
      index += 1;
    }
    if (quoted) throw new Error(`unterminated quoted parameter in: ${line}`);
    const chunk = line.slice(start, index);
    const equals = chunk.indexOf("=");
    if (equals <= 0) throw new Error(`malformed parameter "${chunk}" in: ${line}`);
    params[chunk.slice(0, equals)] = chunk.slice(equals + 1).replace(/^"|"$/g, "");
  }

  if (line[index] !== ":") throw new Error(`property has no value separator: ${line}`);
  return { name, params, value: line.slice(index + 1) };
}

function assertTextEscaping(property: IcsProperty): void {
  const { value, name } = property;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\") {
      const next = value[index + 1];
      if (!next || !"\\;,nN".includes(next)) {
        throw new Error(`invalid escape sequence "\\${next ?? ""}" in ${name}`);
      }
      index += 1;
      continue;
    }
    if (char === ";" || char === ",") throw new Error(`unescaped "${char}" in ${name}: ${value}`);
  }
}

function assertComponent(component: IcsComponent): void {
  const names = new Set(component.properties.map((entry) => entry.name));
  if (component.name === "VEVENT") {
    for (const required of ["UID", "DTSTAMP", "DTSTART"]) {
      if (!names.has(required)) throw new Error(`VEVENT is missing ${required}`);
    }
    const start = component.properties.find((entry) => entry.name === "DTSTART");
    const end = component.properties.find((entry) => entry.name === "DTEND");
    if (start && end) {
      if (start.params.TZID !== end.params.TZID) {
        throw new Error("DTSTART and DTEND disagree about TZID");
      }
      if (end.value <= start.value) {
        throw new Error(`DTEND ${end.value} is not after DTSTART ${start.value}`);
      }
    }
  }
  if (component.name === "VALARM") {
    for (const required of ["ACTION", "TRIGGER"]) {
      if (!names.has(required)) throw new Error(`VALARM is missing ${required}`);
    }
  }
  if (component.name === "VCALENDAR") {
    for (const required of ["VERSION", "PRODID"]) {
      if (!names.has(required)) throw new Error(`VCALENDAR is missing ${required}`);
    }
  }
}

function parseIcs(text: string): IcsDocument {
  if (!text.endsWith("\r\n")) throw new Error("calendar does not end with CRLF");
  if (/\r(?!\n)/.test(text)) throw new Error("bare CR in output");
  if (/(?<!\r)\n/.test(text)) throw new Error("bare LF in output");
  if (text.includes("�")) throw new Error("U+FFFD in output: a multi-octet sequence was split");

  const rawLines = text.slice(0, -2).split("\r\n");
  const unfolded: string[] = [];
  for (const rawLine of rawLines) {
    if (rawLine === "") throw new Error("empty content line");
    if (octets(rawLine) > 75) throw new Error(`line exceeds 75 octets (${octets(rawLine)})`);
    if (rawLine.startsWith(" ") || rawLine.startsWith("\t")) {
      if (unfolded.length === 0) throw new Error("continuation line without a predecessor");
      unfolded[unfolded.length - 1] += rawLine.slice(1);
      continue;
    }
    unfolded.push(rawLine);
  }

  const properties = unfolded.map(splitProperty);
  const stack: IcsComponent[] = [];
  const timezoneIds = new Set<string>();
  const referencedTimezoneIds = new Set<string>();
  let root: IcsComponent | null = null;

  for (const property of properties) {
    if (property.name === "BEGIN") {
      const component: IcsComponent = { name: property.value, properties: [], children: [] };
      if (stack.length === 0) {
        if (root) throw new Error("more than one root component");
        if (component.name !== "VCALENDAR") throw new Error("root component is not VCALENDAR");
        root = component;
      } else {
        stack[stack.length - 1]!.children.push(component);
      }
      stack.push(component);
      continue;
    }
    if (property.name === "END") {
      const opened = stack.pop();
      if (!opened) throw new Error(`END:${property.value} without BEGIN`);
      if (opened.name !== property.value) {
        throw new Error(`END:${property.value} closes ${opened.name}`);
      }
      assertComponent(opened);
      continue;
    }

    const current = stack[stack.length - 1];
    if (!current) throw new Error(`property ${property.name} outside any component`);
    if (TEXT_PROPERTIES.has(property.name)) assertTextEscaping(property);
    if (property.name === "TZID" && current.name === "VTIMEZONE") timezoneIds.add(property.value);
    if (property.params.TZID) referencedTimezoneIds.add(property.params.TZID);
    if (["DTSTART", "DTEND", "DTSTAMP", "CREATED", "LAST-MODIFIED"].includes(property.name)) {
      if (!DATE_TIME.test(property.value)) {
        throw new Error(`${property.name} is not a DATE-TIME: ${property.value}`);
      }
      const inTimezone = current.name === "DAYLIGHT" || current.name === "STANDARD";
      if (!property.params.TZID && !property.value.endsWith("Z") && !inTimezone) {
        throw new Error(`${property.name} is floating local time without TZID`);
      }
      if (["DTSTAMP", "CREATED", "LAST-MODIFIED"].includes(property.name)) {
        if (!property.value.endsWith("Z")) throw new Error(`${property.name} must be UTC`);
      }
    }
    current.properties.push(property);
  }

  if (stack.length > 0) throw new Error(`unclosed component ${stack[stack.length - 1]!.name}`);
  if (!root) throw new Error("no VCALENDAR component");
  for (const referenced of referencedTimezoneIds) {
    if (!timezoneIds.has(referenced)) {
      throw new Error(`TZID=${referenced} is referenced but no VTIMEZONE defines it`);
    }
  }
  return { properties, root };
}

function valid(text: string): IcsDocument {
  return parseIcs(text);
}

function propertyLines(text: string, name: string): string[] {
  return parseIcs(text)
    .properties.filter((property) => property.name === name)
    .map((property) => property.value);
}

function property(text: string, name: string): IcsProperty {
  const found = parseIcs(text).properties.find((entry) => entry.name === name);
  if (!found) throw new Error(`no ${name} in output`);
  return found;
}

function eventProperty(text: string, name: string, index = 0): IcsProperty {
  const event = events(text)[index];
  if (!event) throw new Error(`no VEVENT at index ${index}`);
  const found = event.properties.find((entry) => entry.name === name);
  if (!found) throw new Error(`no ${name} in VEVENT ${index}`);
  return found;
}

function componentsNamed(component: IcsComponent, name: string): IcsComponent[] {
  const found = component.name === name ? [component] : [];
  for (const child of component.children) found.push(...componentsNamed(child, name));
  return found;
}

function events(text: string): IcsComponent[] {
  return componentsNamed(parseIcs(text).root, "VEVENT");
}

function valueOf(component: IcsComponent, name: string): string {
  const found = component.properties.find((entry) => entry.name === name);
  if (!found) throw new Error(`no ${name} in ${component.name}`);
  return found.value;
}

/** Raw, still-folded lines, which is what the folding assertions have to look at. */
function rawLines(text: string): string[] {
  return text.slice(0, -2).split("\r\n");
}

/* ------------------------------------------------------------------ */

const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland"];
const originalHostZone = process.env.TZ;
const secret = "staff-feed-secret-for-tests-00000000";
const originalEnv = { ...process.env };

function withHostTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (originalHostZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalHostZone;
  }
}

const NOW = new Date("2026-07-20T09:02:31.000Z");

const goldenAppointment: IcsAppointmentInput = {
  id: "cme8appt0001",
  startsAt: new Date("2026-08-04T06:00:00.000Z"),
  endsAt: new Date("2026-08-04T07:15:00.000Z"),
  locale: "de",
  status: "confirmed",
  serviceName: "Balayage & Strähnen",
  staffName: "Simona",
  customerName: "Anna Müller",
  customerEmail: "anna.mueller@example.com",
  notes: "Allergie: Ammoniak",
  createdAt: new Date("2026-07-20T09:00:00.000Z"),
  updatedAt: new Date("2026-07-20T09:02:30.000Z"),
  manageUrl: "https://hairsimo.it/de/termin/cme8appt0001",
};

const goldenOptions = { now: NOW };

function appointmentAt(id: string, startIso: string, minutes: number): IcsAppointmentInput {
  const startsAt = new Date(startIso);
  return {
    ...goldenAppointment,
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.reset();
  process.env.STAFF_FEED_TOKEN_SECRET = secret;
  delete process.env.JWT_SECRET;
  delete process.env.SALON_CALENDAR_ORGANIZER_EMAIL;
  delete process.env.GCP_GMAIL_SENDER;
  process.env.NEXT_PUBLIC_BASE_URL = "https://hairsimo.it";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("foldIcsLine", () => {
  it("leaves a line of exactly 75 octets alone and folds at 76", () => {
    const exact = "X-TEST:" + "a".repeat(68);
    expect(octets(exact)).toBe(75);
    expect(foldIcsLine(exact)).toBe(exact);

    const oversize = exact + "b";
    expect(foldIcsLine(oversize)).toBe(`${exact}\r\n b`);
  });

  it("counts OCTETS, not characters: 44 umlauts are 44 characters but 88 octets", () => {
    const line = "ü".repeat(44);
    expect(line.length).toBe(44);
    expect(octets(line)).toBe(88);

    const folded = foldIcsLine(line);
    expect(folded).not.toBe(line);
    const chunks = folded.split("\r\n");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("ü".repeat(37));
    expect(octets(chunks[0]!)).toBe(74);
    expect(chunks[1]).toBe(` ${"ü".repeat(7)}`);
  });

  it("never splits a two-octet character across the 75 octet boundary", () => {
    const line = "SUMMARY:" + "Ä".repeat(40);
    expect(octets(line)).toBe(88);

    const chunks = foldIcsLine(line).split("\r\n");
    expect(chunks[0]).toBe("SUMMARY:" + "Ä".repeat(33));
    expect(octets(chunks[0]!)).toBe(74);
    expect(chunks[1]).toBe(" " + "Ä".repeat(7));
    expect(chunks.join("").replace(/\r\n /g, "")).not.toContain("�");
  });

  it("splits exactly at 75 when the boundary is already on a character edge", () => {
    const line = "A".repeat(9) + "€".repeat(22) + "TAIL";
    expect(octets("A".repeat(9) + "€".repeat(22))).toBe(75);

    const chunks = foldIcsLine(line).split("\r\n");
    expect(chunks[0]).toBe("A".repeat(9) + "€".repeat(22));
    expect(octets(chunks[0]!)).toBe(75);
    expect(chunks[1]).toBe(" TAIL");
  });

  it("never splits a four-octet astral character", () => {
    const line = "A".repeat(72) + "\u{1F600}" + "B";
    expect(octets(line)).toBe(77);

    const chunks = foldIcsLine(line).split("\r\n");
    expect(chunks[0]).toBe("A".repeat(72));
    expect(chunks[1]).toBe(" \u{1F600}B");
    expect(chunks.join("")).not.toContain("�");
  });

  it("gives continuation lines one octet less because the leading space counts", () => {
    const folded = foldIcsLine("z".repeat(400));
    const chunks = folded.split("\r\n");
    expect(octets(chunks[0]!)).toBe(75);
    for (const chunk of chunks.slice(1, -1)) {
      expect(chunk.startsWith(" ")).toBe(true);
      expect(octets(chunk)).toBe(75);
      expect(octets(chunk.slice(1))).toBe(74);
    }
    expect(chunks.join("").replace(/ /g, "")).toBe("z".repeat(400));
  });

  it("round-trips through unfolding for mixed-width content", () => {
    const line = "DESCRIPTION:" + "Straße – Bressanone 😀 ".repeat(20);
    const unfolded = foldIcsLine(line)
      .split("\r\n")
      .map((chunk, index) => (index === 0 ? chunk : chunk.slice(1)))
      .join("");
    expect(unfolded).toBe(line);
  });

  it("honours an explicit octet limit", () => {
    expect(foldIcsLine("abcdefghij", 4)).toBe("abcd\r\n efg\r\n hij");
  });
});

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma and every newline form", () => {
    expect(escapeIcsText("a\\b")).toBe("a\\\\b");
    expect(escapeIcsText("a;b")).toBe("a\\;b");
    expect(escapeIcsText("a,b")).toBe("a\\,b");
    expect(escapeIcsText("a\nb")).toBe("a\\nb");
    expect(escapeIcsText("a\r\nb")).toBe("a\\nb");
    expect(escapeIcsText("a\rb")).toBe("a\\nb");
  });

  it("escapes the backslash first so an escaped comma is not double-escaped", () => {
    expect(escapeIcsText("a\\,b")).toBe("a\\\\\\,b");
    expect(escapeIcsText("\\n")).toBe("\\\\n");
  });

  it("does not touch colon or double quote, which need no escaping in a TEXT value", () => {
    expect(escapeIcsText('Notiz: "kurz"')).toBe('Notiz: "kurz"');
  });

  it("strips C0 control characters and DEL but keeps TAB", () => {
    expect(escapeIcsText("a\u0000b\u0007c\u001fde")).toBe("abcde");
    expect(escapeIcsText("a\tb")).toBe("a\tb");
    expect(escapeIcsText("a\u000bb\u000cc\u007f")).toBe("abc");
  });

  it("leaves accented and astral characters intact", () => {
    expect(escapeIcsText("Strähnen – Bressanone 😀")).toBe("Strähnen – Bressanone 😀");
  });
});

describe("escapeIcsParam", () => {
  it("uses RFC 6868 caret escaping, not the TEXT backslash rules", () => {
    expect(escapeIcsParam("a^b")).toBe("a^^b");
    expect(escapeIcsParam('a"b')).toBe("a^'b");
    expect(escapeIcsParam("a\nb")).toBe("a^nb");
    expect(escapeIcsParam("a\r\nb")).toBe("a^nb");
    expect(escapeIcsParam("a\\b")).toBe("a\\b");
  });

  it("quotes rather than backslash-escapes a separator, unlike escapeIcsText", () => {
    expect(escapeIcsParam("a,b")).toBe('"a,b"');
    expect(escapeIcsParam("a;b")).toBe('"a;b"');
    expect(escapeIcsParam("a:b")).toBe('"a:b"');
    expect(escapeIcsText("a,b")).toBe("a\\,b");
    expect(escapeIcsParam("a,b")).not.toBe(escapeIcsText("a,b"));
  });

  it("escapes the caret before introducing new carets", () => {
    expect(escapeIcsParam('^"')).toBe("^^^'");
  });

  it("strips control characters", () => {
    expect(escapeIcsParam("Sim\u0000ona")).toBe("Simona");
  });

  it("leaves a plain value unquoted", () => {
    expect(escapeIcsParam("Simona")).toBe("Simona");
    expect(escapeIcsParam("Europe/Rome")).toBe("Europe/Rome");
  });
});

describe("appointmentUid", () => {
  it("is stable, so a re-send updates the event instead of duplicating it", () => {
    const first = buildAppointmentIcs(goldenAppointment, goldenOptions);
    const later = buildAppointmentIcs(goldenAppointment, {
      ...goldenOptions,
      now: new Date("2026-07-25T12:00:00.000Z"),
    });
    expect(propertyLines(first, "UID")).toEqual(["cme8appt0001@hairsimo.it"]);
    expect(propertyLines(later, "UID")).toEqual(propertyLines(first, "UID"));
    expect(propertyLines(first, "DTSTAMP")).not.toEqual(propertyLines(later, "DTSTAMP"));
  });

  it("survives a reschedule: same UID, later DTSTART, higher SEQUENCE", () => {
    const rescheduled: IcsAppointmentInput = {
      ...goldenAppointment,
      startsAt: new Date("2026-08-05T06:00:00.000Z"),
      endsAt: new Date("2026-08-05T07:15:00.000Z"),
      updatedAt: new Date("2026-07-20T09:10:00.000Z"),
    };
    const before = buildAppointmentIcs(goldenAppointment, goldenOptions);
    const after = buildAppointmentIcs(rescheduled, goldenOptions);
    expect(propertyLines(after, "UID")).toEqual(propertyLines(before, "UID"));
    expect(Number(propertyLines(after, "SEQUENCE")[0])).toBeGreaterThan(
      Number(propertyLines(before, "SEQUENCE")[0]),
    );
    expect(eventProperty(after, "DTSTART").value).toBe("20260805T080000");
  });

  it("strips characters that are not legal in the local part", () => {
    expect(appointmentUid("appt 1")).toBe("appt1@hairsimo.it");
    expect(appointmentUid("a@b:c")).toBe("abc@hairsimo.it");
    expect(appointmentUid("ok_id-1.2")).toBe("ok_id-1.2@hairsimo.it");
  });

  it("sanitises the domain so it cannot terminate the content line", () => {
    expect(appointmentUid("a", "hairsimo.it")).toBe("a@hairsimo.it");
    expect(appointmentUid("a", "evil\r\nX-INJECTED:1")).toBe("a@evilX-INJECTED1");
  });

  it("throws instead of emitting a UID with an empty half", () => {
    expect(() => appointmentUid("")).toThrow("ICS_INVALID_APPOINTMENT_ID");
    expect(() => appointmentUid("!!!")).toThrow("ICS_INVALID_APPOINTMENT_ID");
    expect(() => appointmentUid("a", "!!!")).toThrow("ICS_INVALID_UID_DOMAIN");
  });

  it("uses the configured domain constant by default", () => {
    expect(appointmentUid("a").endsWith(`@${ICS_UID_DOMAIN}`)).toBe(true);
  });
});

describe("appointmentSequence", () => {
  it("is the whole number of seconds between createdAt and updatedAt", () => {
    expect(
      appointmentSequence({
        createdAt: new Date("2026-07-20T09:00:00.000Z"),
        updatedAt: new Date("2026-07-20T09:02:30.000Z"),
      }),
    ).toBe(150);
  });

  it("is 0 while nothing changes, so a re-sent confirmation stays quiet", () => {
    const stamp = new Date("2026-07-20T09:00:00.000Z");
    expect(appointmentSequence({ createdAt: stamp, updatedAt: stamp })).toBe(0);
    expect(
      appointmentSequence({ createdAt: stamp, updatedAt: new Date(stamp.getTime() + 999) }),
    ).toBe(0);
  });

  it("is 0 rather than negative or NaN for missing or reversed stamps", () => {
    expect(appointmentSequence({})).toBe(0);
    expect(appointmentSequence({ createdAt: new Date(), updatedAt: null })).toBe(0);
    expect(
      appointmentSequence({
        createdAt: new Date("2026-07-20T09:02:30.000Z"),
        updatedAt: new Date("2026-07-20T09:00:00.000Z"),
      }),
    ).toBe(0);
    expect(appointmentSequence({ createdAt: new Date("nope"), updatedAt: new Date() })).toBe(0);
  });

  it("never decreases as updatedAt moves forward", () => {
    const createdAt = new Date("2026-07-20T09:00:00.000Z");
    let previous = -1;
    for (const offset of [0, 1_000, 60_000, 3_600_000, 86_400_000]) {
      const value = appointmentSequence({
        createdAt,
        updatedAt: new Date(createdAt.getTime() + offset),
      });
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("stays inside the 32 bit range RFC 5545 allows", () => {
    const createdAt = new Date("2026-07-20T09:00:00.000Z");
    const updatedAt = new Date(createdAt.getTime() + 3_000_000_000_000);
    expect(appointmentSequence({ createdAt, updatedAt })).toBe(2_147_483_647);
  });
});

describe("buildAppointmentIcs", () => {
  it("produces a valid single-event REQUEST", () => {
    const ics = buildAppointmentIcs(goldenAppointment, goldenOptions);
    const document = valid(ics);

    expect(propertyLines(ics, "METHOD")).toEqual(["REQUEST"]);
    expect(propertyLines(ics, "VERSION")).toEqual(["2.0"]);
    expect(propertyLines(ics, "PRODID")).toEqual([ICS_PRODUCT_ID]);
    expect(propertyLines(ics, "CALSCALE")).toEqual(["GREGORIAN"]);
    expect(document.root.name).toBe("VCALENDAR");
    expect(events(ics)).toHaveLength(1);
    expect(propertyLines(ics, "DTSTAMP")).toEqual(["20260720T090231Z"]);
    expect(propertyLines(ics, "STATUS")).toEqual(["CONFIRMED"]);
    expect(propertyLines(ics, "TRANSP")).toEqual(["OPAQUE"]);
    expect(propertyLines(ics, "SEQUENCE")).toEqual(["150"]);
    expect(propertyLines(ics, "CREATED")).toEqual(["20260720T090000Z"]);
    expect(propertyLines(ics, "LAST-MODIFIED")).toEqual(["20260720T090230Z"]);
  });

  it("uses CRLF everywhere and ends with a trailing CRLF", () => {
    const ics = buildAppointmentIcs(goldenAppointment, goldenOptions);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.endsWith("\r\n\r\n")).toBe(false);
    expect(/\r(?!\n)/.test(ics)).toBe(false);
    expect(/(?<!\r)\n/.test(ics)).toBe(false);
    expect(ics.split("\r\n").filter((line) => line !== "")).toHaveLength(
      ics.split("\r\n").length - 1,
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("carries the organizer and an already-accepted attendee", () => {
    const ics = buildAppointmentIcs(goldenAppointment, goldenOptions);
    const organizer = property(ics, "ORGANIZER");
    expect(organizer.params.CN).toBe("Hair Simo");
    expect(organizer.value).toBe(`mailto:${DEFAULT_ORGANIZER_EMAIL}`);

    const attendee = property(ics, "ATTENDEE");
    expect(attendee.params).toMatchObject({
      CN: "Anna Müller",
      ROLE: "REQ-PARTICIPANT",
      CUTYPE: "INDIVIDUAL",
      PARTSTAT: "ACCEPTED",
      RSVP: "FALSE",
    });
    expect(attendee.value).toBe("mailto:anna.mueller@example.com");
  });

  it("publishes instead of requesting when there is no usable customer address", () => {
    const ics = buildAppointmentIcs({ ...goldenAppointment, customerEmail: null }, goldenOptions);
    valid(ics);
    expect(propertyLines(ics, "METHOD")).toEqual(["PUBLISH"]);
    expect(propertyLines(ics, "ATTENDEE")).toEqual([]);
  });

  it("emits a display alarm by default and honours an override", () => {
    const standard = buildAppointmentIcs(goldenAppointment, goldenOptions);
    expect(propertyLines(standard, "TRIGGER")).toEqual(["-PT2H"]);
    expect(propertyLines(standard, "ACTION")).toEqual(["DISPLAY"]);

    const custom = buildAppointmentIcs(goldenAppointment, {
      ...goldenOptions,
      alarmMinutesBefore: 45,
    });
    expect(propertyLines(custom, "TRIGGER")).toEqual(["-PT45M"]);

    for (const off of [null, 0]) {
      const silent = buildAppointmentIcs(goldenAppointment, {
        ...goldenOptions,
        alarmMinutesBefore: off,
      });
      valid(silent);
      expect(propertyLines(silent, "TRIGGER")).toEqual([]);
      expect(silent).not.toContain("BEGIN:VALARM");
    }
  });

  it("never leaks the back-office note into the customer's file", () => {
    const ics = buildAppointmentIcs(goldenAppointment, goldenOptions);
    expect(ics).not.toContain("Ammoniak");
    expect(propertyLines(ics, "DESCRIPTION").join("")).toContain("Termin verwalten");
  });

  it("renders the description in the appointment locale", () => {
    const italian = buildAppointmentIcs({ ...goldenAppointment, locale: "it" }, goldenOptions);
    valid(italian);
    expect(propertyLines(italian, "DESCRIPTION")[0]).toContain("Servizio: ");
    expect(propertyLines(italian, "LOCATION")[0]).toContain("Bressanone (BZ)\\, Italia");

    const french = buildAppointmentIcs({ ...goldenAppointment, locale: "fr" }, goldenOptions);
    valid(french);
    expect(propertyLines(french, "DESCRIPTION")[0]).toContain("Prestation : ");

    const unknown = buildAppointmentIcs({ ...goldenAppointment, locale: "es" }, goldenOptions);
    expect(propertyLines(unknown, "DESCRIPTION")[0]).toContain("Leistung: ");
  });

  it("maps every AppointmentStatus onto a legal ICS status", () => {
    const expected: Record<string, string> = {
      pending: "TENTATIVE",
      confirmed: "CONFIRMED",
      completed: "CONFIRMED",
      no_show: "CONFIRMED",
      cancelled: "CANCELLED",
    };
    for (const [status, ics] of Object.entries(expected)) {
      const output = buildAppointmentIcs({ ...goldenAppointment, status }, goldenOptions);
      valid(output);
      expect(propertyLines(output, "STATUS")).toEqual([ics]);
    }
    const unknown = buildAppointmentIcs({ ...goldenAppointment, status: "weird" }, goldenOptions);
    expect(propertyLines(unknown, "STATUS")).toEqual(["CONFIRMED"]);
  });

  it("rejects a range that does not move forward", () => {
    const start = new Date("2026-08-04T06:00:00.000Z");
    expect(() =>
      buildAppointmentIcs({ ...goldenAppointment, startsAt: start, endsAt: start }, goldenOptions),
    ).toThrow("ICS_INVALID_TIME_RANGE");
    expect(() =>
      buildAppointmentIcs(
        { ...goldenAppointment, startsAt: start, endsAt: new Date(start.getTime() - 1) },
        goldenOptions,
      ),
    ).toThrow("ICS_INVALID_TIME_RANGE");
  });

  it("rejects structurally impossible input", () => {
    expect(() => buildAppointmentIcs({ ...goldenAppointment, id: "" }, goldenOptions)).toThrow();
    expect(() =>
      buildAppointmentIcs(
        { ...goldenAppointment, startsAt: "2026-08-04" as unknown as Date },
        goldenOptions,
      ),
    ).toThrow();
  });

  it("emits the manage URL as a URI value, not as escaped TEXT", () => {
    const manageUrl = "https://hairsimo.it/de/termin/x?a=1,2;b=3";
    const ics = buildAppointmentIcs({ ...goldenAppointment, manageUrl }, goldenOptions);
    valid(ics);
    expect(property(ics, "URL").value).toBe(manageUrl);
    expect(propertyLines(ics, "DESCRIPTION")[0]).toContain(
      "https://hairsimo.it/de/termin/x?a=1\\,2\\;b=3",
    );
  });

  it("is byte-for-byte reproducible for a fixed now", () => {
    expect(buildAppointmentIcs(goldenAppointment, goldenOptions)).toBe(
      buildAppointmentIcs(goldenAppointment, goldenOptions),
    );
  });
});

describe("line folding in generated calendars", () => {
  it("folds a SUMMARY that straddles the boundary mid-character, with the leading space", () => {
    const ics = buildAppointmentIcs(
      { ...goldenAppointment, serviceName: "Ä".repeat(40), customerEmail: null },
      goldenOptions,
    );
    valid(ics);

    const lines = rawLines(ics);
    const index = lines.findIndex((line) => line.startsWith("SUMMARY:"));
    expect(index).toBeGreaterThan(-1);
    expect(lines[index]).toBe("SUMMARY:" + "Ä".repeat(33));
    expect(octets(lines[index]!)).toBe(74);
    expect(lines[index + 1]).toBe(" " + "Ä".repeat(7) + " – Hair Simo");
    expect(lines[index + 2]!.startsWith(" ")).toBe(false);

    expect(propertyLines(ics, "SUMMARY")).toEqual(["Ä".repeat(40) + " – Hair Simo"]);
  });

  it("keeps every raw line inside 75 octets in every artefact", () => {
    const long = {
      ...goldenAppointment,
      serviceName: "Balayage & Strähnen mit Pflegekur für sehr langes Haar – Spezialbehandlung",
      customerName: "Anna-Maria Müller-Höllrigl",
      notes: "Sehr empfindliche Kopfhaut; bitte nur ammoniakfreie Produkte, kein Föhnen.",
      manageUrl: "https://hairsimo.it/de/termin/cme8appt0001?token=aaaabbbbccccddddeeeeffff",
    };
    const artefacts = [
      buildAppointmentIcs(long, goldenOptions),
      buildCancellationIcs(long, goldenOptions),
      buildStaffFeed([long], { ...goldenOptions, locale: "de" }),
    ];
    for (const artefact of artefacts) {
      valid(artefact);
      for (const line of rawLines(artefact)) {
        expect(octets(line)).toBeLessThanOrEqual(75);
      }
    }
  });

  it("does not corrupt astral characters when folding a real description", () => {
    const ics = buildStaffFeed([{ ...goldenAppointment, notes: "😀".repeat(60) }], {
      ...goldenOptions,
      locale: "de",
    });
    valid(ics);
    expect(ics).not.toContain("�");
    expect(propertyLines(ics, "DESCRIPTION").join("")).toContain("😀".repeat(60));
  });
});

describe("DTSTART and DTEND across the Europe/Rome DST transitions", () => {
  const cases: [string, string, string][] = [
    ["mid summer, CEST", "2026-08-04T06:00:00.000Z", "20260804T080000"],
    ["mid winter, CET", "2026-01-15T07:00:00.000Z", "20260115T080000"],
    ["day before spring forward", "2026-03-28T07:00:00.000Z", "20260328T080000"],
    ["one minute before spring forward", "2026-03-29T00:59:00.000Z", "20260329T015900"],
    ["the instant of spring forward", "2026-03-29T01:00:00.000Z", "20260329T030000"],
    ["day of spring forward, opening", "2026-03-29T06:00:00.000Z", "20260329T080000"],
    ["day before fall back", "2026-10-24T06:00:00.000Z", "20261024T080000"],
    ["inside the last CEST hour", "2026-10-25T00:39:00.000Z", "20261025T023900"],
    ["the instant of fall back", "2026-10-25T01:00:00.000Z", "20261025T020000"],
    ["day of fall back, opening", "2026-10-25T07:00:00.000Z", "20261025T080000"],
  ];

  for (const [name, startIso, expected] of cases) {
    it(`renders the salon wall clock for ${name}`, () => {
      const ics = buildAppointmentIcs(appointmentAt("a1", startIso, 20), goldenOptions);
      valid(ics);
      const start = eventProperty(ics, "DTSTART");
      expect(start.params.TZID).toBe("Europe/Rome");
      expect(start.value).toBe(expected);
    });
  }

  it("keeps an event that crosses the spring gap ordered and honest about local time", () => {
    const ics = buildAppointmentIcs(
      appointmentAt("gap", "2026-03-29T00:30:00.000Z", 60),
      goldenOptions,
    );
    valid(ics);
    expect(eventProperty(ics, "DTSTART").value).toBe("20260329T013000");
    expect(eventProperty(ics, "DTEND").value).toBe("20260329T033000");
  });

  it("falls back to UTC for the one hour that local time cannot express", () => {
    const ics = buildAppointmentIcs(
      appointmentAt("fold", "2026-10-25T00:30:00.000Z", 60),
      goldenOptions,
    );
    valid(ics);
    const start = eventProperty(ics, "DTSTART");
    const end = eventProperty(ics, "DTEND");
    expect(start.params.TZID).toBeUndefined();
    expect(start.value).toBe("20261025T003000Z");
    expect(end.value).toBe("20261025T013000Z");
    expect(end.value > start.value).toBe(true);
  });

  it("still uses TZID for an event wholly inside the repeated hour's first pass", () => {
    const ics = buildAppointmentIcs(
      appointmentAt("early", "2026-10-25T00:00:00.000Z", 20),
      goldenOptions,
    );
    valid(ics);
    expect(eventProperty(ics, "DTSTART").params.TZID).toBe("Europe/Rome");
    expect(eventProperty(ics, "DTSTART").value).toBe("20261025T020000");
    expect(eventProperty(ics, "DTEND").value).toBe("20261025T022000");
  });

  it("emits Z-suffixed UTC and no VTIMEZONE in utc mode", () => {
    const ics = buildAppointmentIcs(goldenAppointment, { ...goldenOptions, timeMode: "utc" });
    valid(ics);
    expect(ics).not.toContain("VTIMEZONE");
    expect(eventProperty(ics, "DTSTART").value).toBe("20260804T060000Z");
    expect(eventProperty(ics, "DTEND").value).toBe("20260804T071500Z");
    expect(eventProperty(ics, "DTSTART").params.TZID).toBeUndefined();
  });

  it("disambiguates the repeated hour when the caller asks for UTC", () => {
    const first = buildAppointmentIcs(appointmentAt("x", "2026-10-25T00:30:00.000Z", 20), {
      ...goldenOptions,
      timeMode: "utc",
    });
    const second = buildAppointmentIcs(appointmentAt("x", "2026-10-25T01:30:00.000Z", 20), {
      ...goldenOptions,
      timeMode: "utc",
    });
    expect(eventProperty(first, "DTSTART").value).toBe("20261025T003000Z");
    expect(eventProperty(second, "DTSTART").value).toBe("20261025T013000Z");

    const localFirst = buildAppointmentIcs(
      appointmentAt("x", "2026-10-25T00:30:00.000Z", 20),
      goldenOptions,
    );
    const localSecond = buildAppointmentIcs(
      appointmentAt("x", "2026-10-25T01:30:00.000Z", 20),
      goldenOptions,
    );
    expect(eventProperty(localFirst, "DTSTART").value).toBe(
      eventProperty(localSecond, "DTSTART").value,
    );
  });

  it("produces the same stamps whatever the host timezone is", () => {
    const rendered = HOST_ZONES.map((zone) =>
      withHostTimeZone(zone, () => buildAppointmentIcs(goldenAppointment, goldenOptions)),
    );
    expect(new Set(rendered).size).toBe(1);
    expect(eventProperty(rendered[0]!, "DTSTART").value).toBe("20260804T080000");
  });
});

describe("the VTIMEZONE it writes for Europe/Rome", () => {
  const ics = () => buildAppointmentIcs(goldenAppointment, goldenOptions);

  function timezoneComponent(): IcsComponent {
    const [component] = componentsNamed(parseIcs(ics()).root, "VTIMEZONE");
    if (!component) throw new Error("no VTIMEZONE");
    return component;
  }

  function offsetMinutes(value: string): number {
    const match = /^([+-])(\d{2})(\d{2})$/.exec(value);
    if (!match) throw new Error(`not a UTC offset: ${value}`);
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
  }

  function lastSundayUtc(year: number, month: number, localMinutes: number, from: number): number {
    const probe = new Date(Date.UTC(year, month, 0));
    const day = probe.getUTCDate() - probe.getUTCDay();
    return Date.UTC(year, month - 1, day) + (localMinutes - from) * 60_000;
  }

  function actualOffsetMinutes(instant: Date): number {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Rome",
      timeZoneName: "longOffset",
    })
      .formatToParts(instant)
      .find((entry) => entry.type === "timeZoneName");
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part?.value ?? "GMT");
    if (!match) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
  }

  type Rule = { month: number; localMinutes: number; from: number; to: number; name: string };

  function ruleOf(kind: "DAYLIGHT" | "STANDARD"): Rule {
    const [component] = componentsNamed(timezoneComponent(), kind);
    if (!component) throw new Error(`no ${kind} subcomponent`);
    const rrule = valueOf(component, "RRULE");
    const parts = Object.fromEntries(
      rrule.split(";").map((entry) => entry.split("=") as [string, string]),
    );
    expect(parts.FREQ).toBe("YEARLY");
    expect(parts.BYDAY).toBe("-1SU");
    const start = valueOf(component, "DTSTART");
    const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(start);
    if (!stamp) throw new Error(`unparseable DTSTART ${start}`);
    return {
      month: Number(parts.BYMONTH),
      localMinutes: Number(stamp[4]) * 60 + Number(stamp[5]),
      from: offsetMinutes(valueOf(component, "TZOFFSETFROM")),
      to: offsetMinutes(valueOf(component, "TZOFFSETTO")),
      name: valueOf(component, "TZNAME"),
    };
  }

  it("declares the zone it is referenced by", () => {
    const component = timezoneComponent();
    expect(valueOf(component, "TZID")).toBe("Europe/Rome");
    expect(eventProperty(ics(), "DTSTART").params.TZID).toBe("Europe/Rome");
  });

  it("names and offsets CET and CEST the right way round", () => {
    const daylight = ruleOf("DAYLIGHT");
    const standard = ruleOf("STANDARD");
    expect(daylight.name).toBe("CEST");
    expect(daylight.from).toBe(60);
    expect(daylight.to).toBe(120);
    expect(standard.name).toBe("CET");
    expect(standard.from).toBe(120);
    expect(standard.to).toBe(60);
    expect(daylight.month).toBe(3);
    expect(standard.month).toBe(10);
  });

  it("anchors both DTSTARTs on a date that really is the last Sunday of its month", () => {
    const component = timezoneComponent();
    for (const kind of ["DAYLIGHT", "STANDARD"] as const) {
      const [sub] = componentsNamed(component, kind);
      const start = valueOf(sub!, "DTSTART");
      const year = Number(start.slice(0, 4));
      const month = Number(start.slice(4, 6));
      const day = Number(start.slice(6, 8));
      const date = new Date(Date.UTC(year, month - 1, day));
      expect(date.getUTCDay()).toBe(0);
      expect(day + 7).toBeGreaterThan(new Date(Date.UTC(year, month, 0)).getUTCDate());
    }
  });

  it("places both 1970 anchors at 01:00 UTC, which is what the EU rule says", () => {
    const daylight = ruleOf("DAYLIGHT");
    const standard = ruleOf("STANDARD");
    expect(daylight.localMinutes - daylight.from).toBe(60);
    expect(standard.localMinutes - standard.from).toBe(60);
  });

  it("reproduces the real Europe/Rome offset for every probe from 2020 to 2035", () => {
    const daylight = ruleOf("DAYLIGHT");
    const standard = ruleOf("STANDARD");

    const predicted = (instant: Date): number => {
      const year = instant.getUTCFullYear();
      const toDst = lastSundayUtc(year, daylight.month, daylight.localMinutes, daylight.from);
      const toStd = lastSundayUtc(year, standard.month, standard.localMinutes, standard.from);
      const time = instant.getTime();
      return time >= toDst && time < toStd ? daylight.to : standard.to;
    };

    const probes: Date[] = [];
    for (let year = 2020; year <= 2035; year += 1) {
      const toDst = lastSundayUtc(year, daylight.month, daylight.localMinutes, daylight.from);
      const toStd = lastSundayUtc(year, standard.month, standard.localMinutes, standard.from);
      for (const anchor of [toDst, toStd]) {
        for (const delta of [-3_600_000, -60_000, 0, 60_000, 3_600_000]) {
          probes.push(new Date(anchor + delta));
        }
      }
      for (const month of [1, 4, 7, 11]) {
        probes.push(new Date(Date.UTC(year, month - 1, 15, 12, 0, 0)));
      }
    }

    for (const probe of probes) {
      expect(`${probe.toISOString()}=${predicted(probe)}`).toBe(
        `${probe.toISOString()}=${actualOffsetMinutes(probe)}`,
      );
    }
  });
});

describe("buildCancellationIcs", () => {
  it("supersedes the invitation: same UID, METHOD:CANCEL, STATUS:CANCELLED, higher SEQUENCE", () => {
    const invitation = buildAppointmentIcs(goldenAppointment, goldenOptions);
    const cancellation = buildCancellationIcs(goldenAppointment, goldenOptions);
    valid(cancellation);

    expect(propertyLines(cancellation, "UID")).toEqual(propertyLines(invitation, "UID"));
    expect(propertyLines(cancellation, "METHOD")).toEqual(["CANCEL"]);
    expect(propertyLines(cancellation, "STATUS")).toEqual(["CANCELLED"]);
    expect(Number(propertyLines(cancellation, "SEQUENCE")[0])).toBe(
      Number(propertyLines(invitation, "SEQUENCE")[0]) + 1,
    );
    expect(propertyLines(cancellation, "ATTENDEE")).toEqual(propertyLines(invitation, "ATTENDEE"));
  });

  it("supersedes even when updatedAt never moved", () => {
    const untouched = {
      ...goldenAppointment,
      updatedAt: goldenAppointment.createdAt,
    };
    const invitation = buildAppointmentIcs(untouched, goldenOptions);
    const cancellation = buildCancellationIcs(untouched, goldenOptions);
    expect(propertyLines(invitation, "SEQUENCE")).toEqual(["0"]);
    expect(propertyLines(cancellation, "SEQUENCE")).toEqual(["1"]);
  });

  it("pins the sequence when the caller passes one, including the falsy zero", () => {
    expect(
      propertyLines(
        buildCancellationIcs(goldenAppointment, { ...goldenOptions, sequence: 9 }),
        "SEQUENCE",
      ),
    ).toEqual(["9"]);
    expect(
      propertyLines(
        buildCancellationIcs(goldenAppointment, { ...goldenOptions, sequence: 0 }),
        "SEQUENCE",
      ),
    ).toEqual(["0"]);
    expect(
      propertyLines(
        buildAppointmentIcs(goldenAppointment, { ...goldenOptions, sequence: 0 }),
        "SEQUENCE",
      ),
    ).toEqual(["0"]);
  });

  it("drops the alarm and states the reason", () => {
    const cancellation = buildCancellationIcs(
      { ...goldenAppointment, cancellationReason: "Krankheit; kurzfristig" },
      goldenOptions,
    );
    valid(cancellation);
    expect(cancellation).not.toContain("BEGIN:VALARM");
    const description = propertyLines(cancellation, "DESCRIPTION")[0]!;
    expect(description).toContain("Dieser Termin wurde abgesagt.");
    expect(description).toContain("Grund: Krankheit\\; kurzfristig");
    expect(propertyLines(cancellation, "SUMMARY")[0]).toContain("Abgesagt: ");
  });

  it("cancels an already-cancelled row without emitting the notice twice", () => {
    const cancellation = buildCancellationIcs(
      { ...goldenAppointment, status: "cancelled" },
      goldenOptions,
    );
    valid(cancellation);
    const description = propertyLines(cancellation, "DESCRIPTION")[0]!;
    expect(description.match(/Dieser Termin wurde abgesagt\./g)).toHaveLength(1);
  });

  it("publishes the cancellation when there is no attendee to notify", () => {
    const ics = buildCancellationIcs({ ...goldenAppointment, customerEmail: null }, goldenOptions);
    valid(ics);
    expect(propertyLines(ics, "METHOD")).toEqual(["PUBLISH"]);
    expect(propertyLines(ics, "STATUS")).toEqual(["CANCELLED"]);
  });
});

describe("buildStaffFeed", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    appointmentAt(
      `feedappt${index}`,
      new Date(Date.parse("2026-08-04T06:00:00.000Z") + index * 86_400_000).toISOString(),
      45,
    ),
  );

  it("wraps many VEVENTs in one subscribable VCALENDAR", () => {
    const feed = buildStaffFeed(many, {
      ...goldenOptions,
      locale: "de",
      calendarName: "Hair Simo – Simona",
    });
    valid(feed);

    expect(events(feed)).toHaveLength(12);
    expect(propertyLines(feed, "X-WR-CALNAME")).toEqual(["Hair Simo – Simona"]);
    expect(propertyLines(feed, "NAME")).toEqual(["Hair Simo – Simona"]);
    expect(propertyLines(feed, "REFRESH-INTERVAL")).toEqual(["PT1H"]);
    expect(property(feed, "REFRESH-INTERVAL").params.VALUE).toBe("DURATION");
    expect(propertyLines(feed, "X-PUBLISHED-TTL")).toEqual(["PT1H"]);
    expect(propertyLines(feed, "X-WR-TIMEZONE")).toEqual(["Europe/Rome"]);
    expect(feed.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(feed.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("carries no METHOD, because a feed is not an iTIP message", () => {
    const feed = buildStaffFeed(many, { ...goldenOptions, locale: "de" });
    expect(propertyLines(feed, "METHOD")).toEqual([]);
    expect(propertyLines(feed, "ATTENDEE")).toEqual([]);
    expect(feed).not.toContain("BEGIN:VALARM");
  });

  it("gives every event a distinct UID so nothing collapses in the client", () => {
    const feed = buildStaffFeed(many, { ...goldenOptions, locale: "de" });
    const uids = events(feed).map((event) => valueOf(event, "UID"));
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("shows the customer and the back-office note to staff", () => {
    const feed = buildStaffFeed([goldenAppointment], { ...goldenOptions, locale: "de" });
    const description = propertyLines(feed, "DESCRIPTION").join("\n");
    expect(description).toContain("Kundin/Kunde: Anna Müller");
    expect(description).toContain("Notiz: Allergie: Ammoniak");
    expect(propertyLines(feed, "SUMMARY")[0]).toBe("Balayage & Strähnen – Anna Müller");
  });

  it("tombstones cancelled appointments by default and can drop them instead", () => {
    const mixed = [
      goldenAppointment,
      { ...appointmentAt("gone", "2026-08-06T06:00:00.000Z", 30), status: "cancelled" },
    ];

    const tombstoned = buildStaffFeed(mixed, { ...goldenOptions, locale: "de" });
    valid(tombstoned);
    expect(events(tombstoned)).toHaveLength(2);
    expect(propertyLines(tombstoned, "STATUS")).toEqual(["CONFIRMED", "CANCELLED"]);

    const omitted = buildStaffFeed(mixed, {
      ...goldenOptions,
      locale: "de",
      cancelledPolicy: "omit",
    });
    valid(omitted);
    expect(events(omitted)).toHaveLength(1);
    expect(omitted).not.toContain("gone@");
  });

  it("stays a valid empty calendar when the stylist has nothing booked", () => {
    const feed = buildStaffFeed([], { ...goldenOptions, locale: "de" });
    valid(feed);
    expect(events(feed)).toHaveLength(0);
    expect(propertyLines(feed, "X-WR-CALNAME")).toEqual(["Hair Simo – Termine"]);
  });

  it("renders the refresh interval as the coarsest legal duration", () => {
    const cases: [number, string][] = [
      [1, "PT5M"],
      [5, "PT5M"],
      [30, "PT30M"],
      [90, "PT90M"],
      [120, "PT2H"],
      [1440, "P1D"],
      [2880, "P2D"],
    ];
    for (const [minutes, expected] of cases) {
      const feed = buildStaffFeed([], {
        ...goldenOptions,
        locale: "de",
        refreshIntervalMinutes: minutes,
      });
      valid(feed);
      expect(propertyLines(feed, "REFRESH-INTERVAL")).toEqual([expected]);
    }
  });

  it("keeps one VTIMEZONE for the whole feed, not one per event", () => {
    const feed = buildStaffFeed(many, { ...goldenOptions, locale: "de" });
    expect(componentsNamed(parseIcs(feed).root, "VTIMEZONE")).toHaveLength(1);
  });

  it("holds events on both sides of both DST transitions in one document", () => {
    const feed = buildStaffFeed(
      [
        appointmentAt("w1", "2026-03-28T07:00:00.000Z", 60),
        appointmentAt("w2", "2026-03-29T06:00:00.000Z", 60),
        appointmentAt("w3", "2026-10-24T06:00:00.000Z", 60),
        appointmentAt("w4", "2026-10-25T07:00:00.000Z", 60),
      ],
      { ...goldenOptions, locale: "de" },
    );
    valid(feed);
    expect(propertyLines(feed, "DTSTART")).toEqual([
      "19700329T020000",
      "19701025T030000",
      "20260328T080000",
      "20260329T080000",
      "20261024T080000",
      "20261025T080000",
    ]);
  });
});

describe("staff feed tokens", () => {
  it("round-trips", () => {
    const token = createStaffFeedToken("staff_1");
    expect(token.startsWith(`${STAFF_FEED_TOKEN_VERSION}.staff_1.`)).toBe(true);
    expect(verifyStaffFeedToken(token)).toEqual({ staffId: "staff_1" });
  });

  it("is deterministic for the same secret and staff id", () => {
    expect(createStaffFeedToken("staff_1")).toBe(createStaffFeedToken("staff_1"));
    expect(createStaffFeedToken("staff_1")).not.toBe(createStaffFeedToken("staff_2"));
  });

  it("rejects a tampered signature", () => {
    const token = createStaffFeedToken("staff_1");
    const [version, id, signature] = token.split(".") as [string, string, string];
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    expect(() => verifyStaffFeedToken(`${version}.${id}.${flipped}`)).toThrow(
      "STAFF_FEED_TOKEN_INVALID",
    );
    expect(() => verifyStaffFeedToken(`${version}.${id}.${signature}extra`)).toThrow(
      "STAFF_FEED_TOKEN_INVALID",
    );
    expect(() => verifyStaffFeedToken(`${version}.${id}.`)).toThrow("STAFF_FEED_TOKEN_INVALID");
  });

  it("rejects a signature lifted onto a different staff id", () => {
    const mine = createStaffFeedToken("staff_1");
    const signature = mine.split(".")[2];
    expect(() => verifyStaffFeedToken(`v1.staff_2.${signature}`)).toThrow(
      "STAFF_FEED_TOKEN_INVALID",
    );
    const theirs = createStaffFeedToken("staff_2");
    expect(verifyStaffFeedToken(theirs)).toEqual({ staffId: "staff_2" });
  });

  it("rejects a token minted under a different secret", () => {
    const token = createStaffFeedToken("staff_1");
    process.env.STAFF_FEED_TOKEN_SECRET = "a-completely-different-secret-value";
    expect(() => verifyStaffFeedToken(token)).toThrow("STAFF_FEED_TOKEN_INVALID");
    process.env.STAFF_FEED_TOKEN_SECRET = secret;
    expect(verifyStaffFeedToken(token)).toEqual({ staffId: "staff_1" });
  });

  it("rejects malformed shapes without telling the attacker which half failed", () => {
    const token = createStaffFeedToken("staff_1");
    const signature = token.split(".")[2]!;
    const bad = [
      "",
      "v1",
      "v1.staff_1",
      `v2.staff_1.${signature}`,
      `V1.staff_1.${signature}`,
      `v1.staff 1.${signature}`,
      `v1..${signature}`,
      `v1.${"x".repeat(129)}.${signature}`,
      `v1.staff_1.${signature}.extra`,
      "../../etc/passwd",
    ];
    for (const candidate of bad) {
      expect(() => verifyStaffFeedToken(candidate)).toThrow("STAFF_FEED_TOKEN_INVALID");
    }
    expect(() => verifyStaffFeedToken(null as unknown as string)).toThrow(
      "STAFF_FEED_TOKEN_INVALID",
    );
  });

  it("rejects a staff id that is not URL-safe at mint time", () => {
    expect(() => createStaffFeedToken("staff 1")).toThrow("STAFF_FEED_STAFF_ID_INVALID");
    expect(() => createStaffFeedToken("staff.1")).toThrow("STAFF_FEED_STAFF_ID_INVALID");
    expect(() => createStaffFeedToken("")).toThrow("STAFF_FEED_STAFF_ID_INVALID");
    expect(() => createStaffFeedToken("x".repeat(129))).toThrow("STAFF_FEED_STAFF_ID_INVALID");
  });

  it("falls back to JWT_SECRET only when the dedicated secret is absent", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env.STAFF_FEED_TOKEN_SECRET;
      process.env.JWT_SECRET = "shared-jwt-secret-for-tests-000000";
      const fresh = await import("./calendar");
      const token = fresh.createStaffFeedToken("staff_1");
      expect(fresh.verifyStaffFeedToken(token)).toEqual({ staffId: "staff_1" });
      expect(warn).toHaveBeenCalledTimes(1);

      fresh.createStaffFeedToken("staff_2");
      expect(warn).toHaveBeenCalledTimes(1);

      delete process.env.JWT_SECRET;
      expect(() => fresh.createStaffFeedToken("staff_1")).toThrow(
        "STAFF_FEED_TOKEN_SECRET_MISSING",
      );
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("builds an absolute subscription URL in both schemes", () => {
    const token = createStaffFeedToken("staff_1");
    expect(staffFeedUrl("staff_1")).toBe(`https://hairsimo.it/api/calendar/staff/${token}.ics`);
    expect(staffFeedUrl("staff_1", "https://hairsimo.it/", "webcal")).toBe(
      `webcal://hairsimo.it/api/calendar/staff/${token}.ics`,
    );
    expect(staffFeedUrl("staff_1", "https://hairsimo.it///")).toBe(
      `https://hairsimo.it/api/calendar/staff/${token}.ics`,
    );
  });
});

describe("icsFilename", () => {
  it("cannot be used to escape a directory or break a header", () => {
    expect(icsFilename("cme8appt0001")).toBe("hair-simo-cme8appt0001.ics");
    expect(icsFilename("../../etc/passwd")).toBe("hair-simo-....etcpasswd.ics");
    expect(icsFilename('a"; drop', "feed")).toBe("feed-adrop.ics");
  });
});

describe("toIcsAppointment", () => {
  const row = {
    id: "cme8appt0001",
    startsAt: new Date("2026-08-04T06:00:00.000Z"),
    endsAt: new Date("2026-08-04T07:15:00.000Z"),
    locale: "it",
    status: "confirmed" as const,
    notes: "nota interna",
    cancellationReason: null,
    createdAt: new Date("2026-07-20T09:00:00.000Z"),
    updatedAt: new Date("2026-07-20T09:02:30.000Z"),
    service: {
      slug: "balayage",
      translations: [
        { locale: "de", name: "Balayage & Strähnen" },
        { locale: "it", name: "Balayage e colpi di sole" },
      ],
    },
    staff: { displayName: "Simona" },
    customer: {
      firstName: "Anna",
      lastName: "Müller",
      email: "anna@example.com",
      deletedAt: null,
      anonymizedAt: null,
    },
  };

  it("picks the service name for the appointment locale", () => {
    expect(toIcsAppointment(row).serviceName).toBe("Balayage e colpi di sole");
    expect(toIcsAppointment({ ...row, locale: "de" }).serviceName).toBe("Balayage & Strähnen");
    expect(toIcsAppointment({ ...row, locale: "fr" }).serviceName).toBe("balayage");
  });

  it("suppresses the identity of a deleted or anonymised customer", () => {
    for (const key of ["deletedAt", "anonymizedAt"] as const) {
      const erased = toIcsAppointment({
        ...row,
        customer: { ...row.customer, [key]: new Date("2026-07-01T00:00:00.000Z") },
      });
      expect(erased.customerName).toBeNull();
      expect(erased.customerEmail).toBeNull();
    }
  });

  it("survives a missing service, staff or customer", () => {
    const bare = toIcsAppointment({ ...row, service: null, staff: null, customer: null });
    expect(bare.serviceName).toBeNull();
    expect(bare.staffName).toBeNull();
    expect(bare.customerName).toBeNull();
    const ics = buildAppointmentIcs(bare, goldenOptions);
    valid(ics);
    expect(propertyLines(ics, "SUMMARY")[0]).toBe("Appuntamento – Hair Simo");
  });

  it("normalises an unsupported locale to the default", () => {
    expect(toIcsAppointment({ ...row, locale: "es" }).locale).toBe("de");
  });
});

describe("Prisma-backed reads", () => {
  function seedStaff(id: string, active = true) {
    store.staffProfiles.push({
      id,
      displayName: `Stylist ${id}`,
      locale: "de",
      user: { active },
    });
  }

  function seedAppointment(id: string, staffId: string, startIso: string) {
    const startsAt = new Date(startIso);
    store.appointments.push({
      id,
      staffId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 45 * 60_000),
      locale: "de",
      status: "confirmed",
      notes: `note for ${id}`,
      cancellationReason: null,
      createdAt: new Date("2026-07-20T09:00:00.000Z"),
      updatedAt: new Date("2026-07-20T09:02:30.000Z"),
      service: { slug: "cut", translations: [{ locale: "de", name: "Schnitt" }] },
      staff: { displayName: `Stylist ${staffId}` },
      customer: {
        firstName: "Kunde",
        lastName: id,
        email: `${id}@example.com`,
        deletedAt: null,
        anonymizedAt: null,
      },
    });
  }

  it("loadAppointmentForIcs maps a row and returns null for a miss", async () => {
    seedAppointment("a1", "staff_1", "2026-08-04T06:00:00.000Z");
    const loaded = await loadAppointmentForIcs("a1");
    expect(loaded?.serviceName).toBe("Schnitt");
    expect(loaded?.customerName).toBe("Kunde a1");
    expect(await loadAppointmentForIcs("missing")).toBeNull();
  });

  it("loadStaffFeedAppointments bounds the window and the row count", async () => {
    const now = Date.now();
    seedAppointment("old", "staff_1", new Date(now - 40 * 86_400_000).toISOString());
    seedAppointment("recent", "staff_1", new Date(now - 5 * 86_400_000).toISOString());
    seedAppointment("soon", "staff_1", new Date(now + 5 * 86_400_000).toISOString());
    seedAppointment("far", "staff_1", new Date(now + 300 * 86_400_000).toISOString());
    seedAppointment("other", "staff_2", new Date(now + 5 * 86_400_000).toISOString());

    const loaded = await loadStaffFeedAppointments("staff_1");
    expect(loaded.map((entry) => entry.id)).toEqual(["recent", "soon"]);

    const args = db.appointment.findMany.mock.calls[0]![0] as Row;
    expect(args.orderBy).toEqual({ startsAt: "asc" });
    expect(args.take).toBe(2_000);
    expect((args.where as Row).staffId).toBe("staff_1");
  });

  it("clamps a caller supplied limit into the safe range", async () => {
    seedAppointment("a1", "staff_1", new Date(Date.now() + 86_400_000).toISOString());
    await loadStaffFeedAppointments("staff_1", { limit: 100_000 });
    expect((db.appointment.findMany.mock.calls[0]![0] as Row).take).toBe(2_000);
    await loadStaffFeedAppointments("staff_1", { limit: 0 });
    expect((db.appointment.findMany.mock.calls[1]![0] as Row).take).toBe(1);
  });

  it("honours an explicit range with an exclusive upper bound", async () => {
    seedAppointment("inside", "staff_1", "2026-08-04T06:00:00.000Z");
    seedAppointment("edge", "staff_1", "2026-08-05T00:00:00.000Z");
    const loaded = await loadStaffFeedAppointments("staff_1", {
      from: new Date("2026-08-04T00:00:00.000Z"),
      to: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(loaded.map((entry) => entry.id)).toEqual(["inside"]);
  });

  it("buildStaffFeedForToken serves an active stylist", async () => {
    seedStaff("staff_1");
    seedAppointment("a1", "staff_1", new Date(Date.now() + 86_400_000).toISOString());
    seedAppointment("a2", "staff_1", new Date(Date.now() + 2 * 86_400_000).toISOString());

    const result = await buildStaffFeedForToken(createStaffFeedToken("staff_1"));
    valid(result.calendar);
    expect(result.staffId).toBe("staff_1");
    expect(result.staffName).toBe("Stylist staff_1");
    expect(result.contentType).toBe(ICS_CONTENT_TYPE);
    expect(result.filename).toBe("hair-simo-staff_1.ics");
    expect(result.eventCount).toBe(2);
    expect(events(result.calendar)).toHaveLength(2);
    expect(propertyLines(result.calendar, "X-WR-CALNAME")).toEqual([
      "Hair Simo – Termine – Stylist staff_1",
    ]);
  });

  it("counts only the events it actually emitted", async () => {
    seedStaff("staff_1");
    seedAppointment("a1", "staff_1", new Date(Date.now() + 86_400_000).toISOString());
    store.appointments[0]!.status = "cancelled";
    seedAppointment("a2", "staff_1", new Date(Date.now() + 2 * 86_400_000).toISOString());

    const tombstoned = await buildStaffFeedForToken(createStaffFeedToken("staff_1"));
    expect(tombstoned.eventCount).toBe(2);
    expect(events(tombstoned.calendar)).toHaveLength(2);

    const omitted = await buildStaffFeedForToken(createStaffFeedToken("staff_1"), {
      cancelledPolicy: "omit",
    });
    expect(omitted.eventCount).toBe(1);
    expect(events(omitted.calendar)).toHaveLength(1);
  });

  it("refuses a deactivated or unknown stylist", async () => {
    seedStaff("staff_off", false);
    await expect(buildStaffFeedForToken(createStaffFeedToken("staff_off"))).rejects.toThrow(
      "STAFF_FEED_NOT_FOUND",
    );
    await expect(buildStaffFeedForToken(createStaffFeedToken("staff_gone"))).rejects.toThrow(
      "STAFF_FEED_NOT_FOUND",
    );
  });

  it("never touches the database for an invalid token", async () => {
    await expect(buildStaffFeedForToken("v1.staff_1.forged")).rejects.toThrow(
      "STAFF_FEED_TOKEN_INVALID",
    );
    expect(db.staffProfile.findUnique).not.toHaveBeenCalled();
    expect(db.appointment.findMany).not.toHaveBeenCalled();
  });
});

describe("adversarial input", () => {
  it("cannot be talked into a second VEVENT through a service name", () => {
    const injected = "Cut\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:evil@attacker\r\nSUMMARY:Evil";
    const ics = buildAppointmentIcs({ ...goldenAppointment, serviceName: injected }, goldenOptions);
    valid(ics);
    expect(events(ics)).toHaveLength(1);
    expect(propertyLines(ics, "UID")).toEqual(["cme8appt0001@hairsimo.it"]);
    expect(propertyLines(ics, "SUMMARY")[0]).toContain("\\nEND:VEVENT\\nBEGIN:VEVENT\\n");
  });

  it("cannot be talked into a second VEVENT through the customer e-mail address", () => {
    const ics = buildAppointmentIcs(
      {
        ...goldenAppointment,
        customerEmail:
          "anna@example.com\r\nBEGIN:VEVENT\r\nUID:evil@attacker\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT",
      },
      goldenOptions,
    );
    valid(ics);
    expect(events(ics)).toHaveLength(1);
    expect(ics).not.toContain("evil@attacker");
    expect(propertyLines(ics, "ATTENDEE")).toEqual([]);
    expect(propertyLines(ics, "METHOD")).toEqual(["PUBLISH"]);
  });

  it("cannot be talked into a forged ORGANIZER through the environment", () => {
    process.env.SALON_CALENDAR_ORGANIZER_EMAIL = "boss@hairsimo.it\r\nX-INJECTED:1";
    const ics = buildAppointmentIcs(goldenAppointment, goldenOptions);
    valid(ics);
    expect(propertyLines(ics, "X-INJECTED")).toEqual([]);
    expect(property(ics, "ORGANIZER").value).toBe(`mailto:${DEFAULT_ORGANIZER_EMAIL}`);
  });

  it("cannot be talked into extra parameters through a customer name", () => {
    const ics = buildAppointmentIcs(
      { ...goldenAppointment, customerName: 'Anna";ROLE=CHAIR;X-EVIL=1:mailto:evil@attacker' },
      goldenOptions,
    );
    valid(ics);
    const attendee = property(ics, "ATTENDEE");
    expect(attendee.value).toBe("mailto:anna.mueller@example.com");
    expect(attendee.params.ROLE).toBe("REQ-PARTICIPANT");
    expect(attendee.params["X-EVIL"]).toBeUndefined();
    expect(attendee.params.CN).toContain("^'");
  });

  it("strips control characters that a client would refuse to parse", () => {
    const ics = buildStaffFeed([{ ...goldenAppointment, notes: "vor\u0000sicht\u0007 bitte" }], {
      ...goldenOptions,
      locale: "de",
    });
    valid(ics);
    // eslint-disable-next-line no-control-regex -- asserting the absence of exactly these
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(ics)).toBe(false);
    expect(propertyLines(ics, "DESCRIPTION").join("")).toContain("vorsicht bitte");
  });

  it("keeps a folded escape sequence intact once the client unfolds it", () => {
    const ics = buildAppointmentIcs(
      { ...goldenAppointment, serviceName: `${"a".repeat(60)},${"b".repeat(60)}` },
      goldenOptions,
    );
    valid(ics);
    expect(propertyLines(ics, "SUMMARY")[0]).toBe(
      `${"a".repeat(60)}\\,${"b".repeat(60)} – Hair Simo`,
    );
  });

  it("does not let one corrupt row silently disappear from a feed", () => {
    expect(() =>
      buildStaffFeed(
        [
          goldenAppointment,
          { ...goldenAppointment, id: "bad", endsAt: goldenAppointment.startsAt },
        ],
        { ...goldenOptions, locale: "de" },
      ),
    ).toThrow("ICS_INVALID_TIME_RANGE");
  });
});

describe("concurrency", () => {
  it("keeps concurrent feed builds from bleeding into each other", async () => {
    store.setLatency(1);
    const staffIds = ["staff_a", "staff_b", "staff_c", "staff_d"];
    for (const staffId of staffIds) {
      store.staffProfiles.push({
        id: staffId,
        displayName: `Stylist ${staffId}`,
        locale: "de",
        user: { active: true },
      });
      for (let index = 0; index < 6; index += 1) {
        const startsAt = new Date(Date.now() + (index + 1) * 86_400_000);
        store.appointments.push({
          id: `${staffId}-appt-${index}`,
          staffId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 45 * 60_000),
          locale: "de",
          status: "confirmed",
          notes: null,
          cancellationReason: null,
          createdAt: new Date("2026-07-20T09:00:00.000Z"),
          updatedAt: new Date("2026-07-20T09:02:30.000Z"),
          service: { slug: "cut", translations: [{ locale: "de", name: "Schnitt" }] },
          staff: { displayName: `Stylist ${staffId}` },
          customer: {
            firstName: "Kunde",
            lastName: `${staffId}-${index}`,
            email: `${staffId}${index}@example.com`,
            deletedAt: null,
            anonymizedAt: null,
          },
        });
      }
    }

    const tokens = staffIds.map((staffId) => createStaffFeedToken(staffId));
    const reference = new Map<string, string>();
    for (let index = 0; index < staffIds.length; index += 1) {
      const single = await buildStaffFeedForToken(tokens[index]!, { now: NOW });
      reference.set(staffIds[index]!, single.calendar);
    }

    const interleaved = await Promise.all(
      Array.from({ length: 40 }, (_, index) => {
        const position = index % staffIds.length;
        return buildStaffFeedForToken(tokens[position]!, { now: NOW });
      }),
    );

    for (let index = 0; index < interleaved.length; index += 1) {
      const staffId = staffIds[index % staffIds.length]!;
      const result = interleaved[index]!;
      expect(result.staffId).toBe(staffId);
      expect(result.calendar).toBe(reference.get(staffId));
      valid(result.calendar);
      for (const other of staffIds) {
        if (other === staffId) continue;
        expect(result.calendar).not.toContain(`${other}-appt-`);
      }
    }
  });

  it("does not serve a stylist deactivated while their feed was loading", async () => {
    store.setLatency(2);
    store.staffProfiles.push({
      id: "staff_race",
      displayName: "Stylist race",
      locale: "de",
      user: { active: true },
    });
    const token = createStaffFeedToken("staff_race");

    await expect(buildStaffFeedForToken(token, { now: NOW })).resolves.toMatchObject({
      staffId: "staff_race",
    });

    const inFlight = buildStaffFeedForToken(token, { now: NOW });
    (store.staffProfiles[0]!.user as { active: boolean }).active = false;
    await expect(inFlight).rejects.toThrow("STAFF_FEED_NOT_FOUND");
  });

  it("survives a secret rotation between minting and verifying", async () => {
    const token = createStaffFeedToken("staff_1");
    const rotate = async () => {
      await Promise.resolve();
      process.env.STAFF_FEED_TOKEN_SECRET = "rotated-secret-value-000000000000";
    };
    const verifyLater = async () => {
      await Promise.resolve();
      await Promise.resolve();
      return verifyStaffFeedToken(token);
    };
    const [, outcome] = await Promise.allSettled([rotate(), verifyLater()]);
    expect(outcome.status).toBe("rejected");
  });

  it("produces identical bytes for the same input built many times in parallel", async () => {
    const expected = buildAppointmentIcs(goldenAppointment, goldenOptions);
    const built = await Promise.all(
      Array.from({ length: 64 }, async (_, index) => {
        await new Promise((resolve) => setTimeout(resolve, index % 3));
        return buildAppointmentIcs(goldenAppointment, goldenOptions);
      }),
    );
    expect(new Set(built).size).toBe(1);
    expect(built[0]).toBe(expected);
  });
});

describe("host timezone independence", () => {
  it("renders identical bytes for every artefact under UTC, Europe/Rome and Pacific/Auckland", () => {
    for (const builder of [
      () => buildAppointmentIcs(goldenAppointment, goldenOptions),
      () => buildCancellationIcs(goldenAppointment, goldenOptions),
      () => buildStaffFeed([goldenAppointment], { ...goldenOptions, locale: "de" }),
    ]) {
      const rendered = HOST_ZONES.map((zone) => withHostTimeZone(zone, builder));
      for (const artefact of rendered) valid(artefact);
      expect(new Set(rendered).size).toBe(1);
    }
  });
});
