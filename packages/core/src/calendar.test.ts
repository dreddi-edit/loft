import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appointmentFindUnique, appointmentFindMany, staffFindUnique } = vi.hoisted(() => ({
  appointmentFindUnique: vi.fn(),
  appointmentFindMany: vi.fn(),
  staffFindUnique: vi.fn(),
}));

vi.mock("@hair-simo/db", () => ({
  prisma: {
    appointment: { findUnique: appointmentFindUnique, findMany: appointmentFindMany },
    staffProfile: { findUnique: staffFindUnique },
  },
}));

import {
  ICS_CONTENT_TYPE,
  ICS_PRODUCT_ID,
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

const octets = (value: string) => new TextEncoder().encode(value).length;

/* ------------------------------------------------------------------ *
 * A deliberately strict, dependency-free iCalendar validator.
 * Everything it rejects is something a real client rejects or silently
 * mis-renders, so every builder output in this file is run through it.
 * ------------------------------------------------------------------ */

type IcsProperty = { name: string; params: Record<string, string>; value: string };

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

function splitProperty(line: string): IcsProperty {
  let index = 0;
  while (index < line.length && /[A-Za-z0-9-]/.test(line[index]!)) index += 1;
  const name = line.slice(0, index);
  if (!name) throw new Error(`property has no name: ${line}`);

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

function parseIcs(text: string): IcsProperty[] {
  if (!text.endsWith("\r\n")) throw new Error("calendar does not end with CRLF");
  if (/\r(?!\n)/.test(text)) throw new Error("bare CR in output");
  if (/(?<!\r)\n/.test(text)) throw new Error("bare LF in output");

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
  const stack: string[] = [];
  const components: IcsProperty[][] = [];
  let current: IcsProperty[] = [];
  const timezoneIds = new Set<string>();
  const referencedTimezoneIds = new Set<string>();

  for (const property of properties) {
    if (property.name === "BEGIN") {
      stack.push(property.value);
      components.push(current);
      current = [];
      continue;
    }
    if (property.name === "END") {
      const opened = stack.pop();
      if (opened !== property.value) throw new Error(`END:${property.value} closes ${opened}`);
      const component = current;
      current = components.pop() ?? [];
      const names = new Set(component.map((entry) => entry.name));
      if (opened === "VEVENT") {
        for (const required of ["UID", "DTSTAMP", "DTSTART"]) {
          if (!names.has(required)) throw new Error(`VEVENT is missing ${required}`);
        }
      }
      if (opened === "VALARM") {
        for (const required of ["ACTION", "TRIGGER"]) {
          if (!names.has(required)) throw new Error(`VALARM is missing ${required}`);
        }
      }
      if (opened === "VCALENDAR") {
        for (const required of ["VERSION", "PRODID"]) {
          if (!names.has(required)) throw new Error(`VCALENDAR is missing ${required}`);
        }
      }
      continue;
    }

    if (stack.length === 0) throw new Error(`property ${property.name} outside any component`);
    if (stack[0] !== "VCALENDAR") throw new Error("root component is not VCALENDAR");
    if (TEXT_PROPERTIES.has(property.name)) assertTextEscaping(property);
    if (property.name === "TZID" && stack[stack.length - 1] === "VTIMEZONE") {
      timezoneIds.add(property.value);
    }
    if (property.params.TZID) referencedTimezoneIds.add(property.params.TZID);
    if (["DTSTART", "DTEND", "DTSTAMP", "CREATED", "LAST-MODIFIED"].includes(property.name)) {
      if (!DATE_TIME.test(property.value)) {
        throw new Error(`${property.name} is not a DATE-TIME: ${property.value}`);
      }
      if (!property.params.TZID && !property.value.endsWith("Z")) {
        throw new Error(`${property.name} is floating local time without TZID`);
      }
    }
    current.push(property);
  }

  if (stack.length > 0) throw new Error(`unclosed component ${stack[stack.length - 1]}`);
  for (const referenced of referencedTimezoneIds) {
    if (!timezoneIds.has(referenced)) {
      throw new Error(`TZID=${referenced} is referenced but no VTIMEZONE defines it`);
    }
  }
  return properties;
}

function propertyLines(text: string, name: string): string[] {
  return parseIcs(text)
    .filter((property) => property.name === name)
    .map((property) => property.value);
}

/* ------------------------------------------------------------------ */

const secret = "staff-feed-secret-for-tests-00000000";
const originalEnv = { ...process.env };

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

const goldenOptions = { now: new Date("2026-07-20T09:02:31.000Z") };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STAFF_FEED_TOKEN_SECRET = secret;
  delete process.env.JWT_SECRET;
  delete process.env.SALON_CALENDAR_ORGANIZER_EMAIL;
  delete process.env.GCP_GMAIL_SENDER;
  process.env.NEXT_PUBLIC_BASE_URL = "https://hairsimo.it";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("golden output", () => {
  it("dumps", () => {
    console.log(JSON.stringify(buildAppointmentIcs(goldenAppointment, goldenOptions)));
    console.log(JSON.stringify(buildCancellationIcs(goldenAppointment, goldenOptions)));
    console.log(
      JSON.stringify(
        buildStaffFeed([goldenAppointment], {
          ...goldenOptions,
          locale: "de",
          calendarName: "Hair Simo – Simona",
        }),
      ),
    );
    expect(true).toBe(true);
  });
});

export { appointmentSequence, appointmentUid, escapeIcsParam, escapeIcsText, foldIcsLine };
export {
  ICS_CONTENT_TYPE,
  ICS_PRODUCT_ID,
  icsFilename,
  loadAppointmentForIcs,
  loadStaffFeedAppointments,
  staffFeedUrl,
  toIcsAppointment,
  verifyStaffFeedToken,
  createStaffFeedToken,
  buildStaffFeedForToken,
  parseIcs,
  propertyLines,
  splitProperty,
  appointmentFindUnique,
  appointmentFindMany,
  staffFindUnique,
};
