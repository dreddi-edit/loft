/**
 * iCalendar (RFC 5545) generation for the salon.
 *
 * The owner deliberately rejected a Google Calendar OAuth two-way sync: refresh tokens
 * that silently expire, seven-day watch-channel renewals and conflict resolution are
 * ongoing maintenance that a four-person salon cannot carry. What is built here instead
 * is the boring, durable half of the same feature:
 *
 *   - an .ics attachment on the confirmation mail (one VEVENT, METHOD:REQUEST),
 *   - a matching METHOD:CANCEL file so a cancelled appointment leaves the calendar,
 *   - a read-only subscribable VCALENDAR feed per staff member, which Google Calendar,
 *     Apple Calendar and Outlook all poll on their own schedule.
 *
 * Nothing here talks to a third party, nothing holds a credential that expires, and the
 * whole surface is a pure string builder plus two small Prisma reads.
 *
 * ## Why local times with a VTIMEZONE and not UTC with a Z suffix
 *
 * Both are legal. UTC instants are simpler and never ambiguous, but they encode "this
 * absolute moment" and lose "08:00 in the shop". The salon is a physical room in
 * Bressanone: the business truth is the wall clock on its wall. A stylist whose laptop
 * is set to UTC, or a customer whose phone is still on holiday time, must still see
 * 08:00, so every dated property is emitted as a local time tagged with
 * `TZID=Europe/Rome` and the calendar carries the matching VTIMEZONE component.
 *
 * The one thing local times cannot express is the repeated hour on the October
 * fall-back Sunday, where 02:30 happens twice and a client picks the first occurrence.
 * Salon hours are 08:00-17:00, so that hour is unreachable in practice. For any caller
 * that needs an unambiguous instant regardless (an integration test, an export consumed
 * by a machine) `timeMode: "utc"` switches every property to a Z-suffixed UTC stamp and
 * drops the VTIMEZONE.
 *
 * If `SALON_TIME_ZONE` is ever pointed somewhere other than a zone we ship a hand-written
 * VTIMEZONE for, the builder falls back to UTC rather than emitting a TZID that the
 * calendar does not define — an undefined TZID is the single most common way to make
 * Outlook silently shift an event by an hour.
 *
 * ## Feed authentication
 *
 * A calendar client subscribing to a URL cannot send an Authorization header, so the
 * credential has to live in the URL. `createStaffFeedToken` derives an unguessable
 * HMAC-SHA256 tag from a server secret plus the staff id; `verifyStaffFeedToken`
 * recomputes it in constant time. It is deliberately not a JWT: these URLs are pasted
 * into calendar apps and live there for years, so an `exp` claim would just break the
 * subscription, and a JWT's payload would leak more than the staff id already does.
 *
 * Because the tag is deterministic it cannot be revoked individually today. See
 * {@link verifyStaffFeedToken} for the two levers that exist and the one-column schema
 * change that would fix it properly.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@hair-simo/db";
import { getServiceTranslationName, resolveLocale } from "@hair-simo/i18n";
import { SALON_TIME_ZONE, formatInSalonZone, formatSalonTimeRange } from "./time";
import type { AppointmentStatus } from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";

export const ICS_PRODUCT_ID = "-//Hair Simo//Salon Booking 1.0//EN";
export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";
export const ICS_UID_DOMAIN = "hairsimo.it";
export const DEFAULT_ORGANIZER_EMAIL = "termine@hairsimo.it";
export const DEFAULT_ORGANIZER_NAME = "Hair Simo";
export const STAFF_FEED_TOKEN_VERSION = "v1";

const MAX_LINE_OCTETS = 75;
const MAX_SEQUENCE = 2_147_483_647;
const DEFAULT_ALARM_MINUTES = 120;
const DEFAULT_REFRESH_MINUTES = 60;
const DEFAULT_FEED_PAST_DAYS = 30;
const DEFAULT_FEED_FUTURE_DAYS = 180;
const DEFAULT_FEED_LIMIT = 2_000;
const MS_PER_DAY = 86_400_000;
const SALON_PHONE = "+39 0472 268402";
const FEED_TOKEN_CONTEXT = "hair-simo:staff-calendar-feed";
const FEED_TOKEN_ERROR = "STAFF_FEED_TOKEN_INVALID";
const SAFE_TOKEN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_UID_CHARS = /[^A-Za-z0-9._-]/g;
// A CAL-ADDRESS is interpolated raw after "mailto:", so anything that could close the
// property or open a new content line has to be rejected before it gets there.
const SAFE_CAL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
// Everything C0/C1 except CR and LF, which are escaped into a literal \n instead.
// eslint-disable-next-line no-control-regex -- RFC 5545 forbids these in TEXT values
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Hand-written VTIMEZONE components. Only zones listed here may be emitted as a TZID.
 *
 * Europe/Rome follows the EU-wide rule in force since 1996: to CEST on the last Sunday
 * of March at 01:00 UTC, back to CET on the last Sunday of October at 01:00 UTC. In a
 * VTIMEZONE subcomponent DTSTART is a local time read against TZOFFSETFROM, so
 * `19700329T020000` at +0100 and `19701025T030000` at +0200 both denote 01:00 UTC. The
 * 1970 anchors are the conventional ones (Google Calendar emits the same); they predate
 * the harmonised rule, but no appointment this system stores is anywhere near them and
 * every client evaluates the RRULE rather than the anchor.
 */
const VTIMEZONE_COMPONENTS: Record<string, string[]> = {
  "Europe/Rome": [
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Rome",
    "X-LIC-LOCATION:Europe/Rome",
    "BEGIN:DAYLIGHT",
    "TZNAME:CEST",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZNAME:CET",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ],
};

type CalendarStrings = {
  colon: string;
  appointment: string;
  service: string;
  team: string;
  customer: string;
  when: string;
  address: string;
  phone: string;
  note: string;
  manage: string;
  reason: string;
  cancelledPrefix: string;
  cancelledNotice: string;
  alarm: string;
  location: string;
  feedName: string;
  feedDescription: string;
};

/**
 * Customer-facing calendar copy. It lives here rather than in @hair-simo/i18n because a
 * later phase consolidates the dictionaries; the keys to move are listed in the handover
 * notes. French keeps its narrow-space-before-colon convention, which is why the label
 * separator is per locale and not a hardcoded ": ".
 */
const CALENDAR_STRINGS: Record<AppLocale, CalendarStrings> = {
  de: {
    colon: ": ",
    appointment: "Termin",
    service: "Leistung",
    team: "Team",
    customer: "Kundin/Kunde",
    when: "Termin",
    address: "Adresse",
    phone: "Telefon",
    note: "Notiz",
    manage: "Termin verwalten",
    reason: "Grund",
    cancelledPrefix: "Abgesagt",
    cancelledNotice: "Dieser Termin wurde abgesagt.",
    alarm: "Erinnerung: Ihr Termin bei Hair Simo",
    location: "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Brixen (Bressanone), Italien",
    feedName: "Hair Simo – Termine",
    feedDescription: "Automatisch aktualisierter Terminkalender von Hair Simo.",
  },
  it: {
    colon: ": ",
    appointment: "Appuntamento",
    service: "Servizio",
    team: "Team",
    customer: "Cliente",
    when: "Appuntamento",
    address: "Indirizzo",
    phone: "Telefono",
    note: "Nota",
    manage: "Gestisci appuntamento",
    reason: "Motivo",
    cancelledPrefix: "Annullato",
    cancelledNotice: "Questo appuntamento è stato annullato.",
    alarm: "Promemoria: il tuo appuntamento da Hair Simo",
    location: "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italia",
    feedName: "Hair Simo – Appuntamenti",
    feedDescription: "Calendario appuntamenti di Hair Simo, aggiornato automaticamente.",
  },
  fr: {
    colon: " : ",
    appointment: "Rendez-vous",
    service: "Prestation",
    team: "Équipe",
    customer: "Client(e)",
    when: "Rendez-vous",
    address: "Adresse",
    phone: "Téléphone",
    note: "Note",
    manage: "Gérer le rendez-vous",
    reason: "Motif",
    cancelledPrefix: "Annulé",
    cancelledNotice: "Ce rendez-vous a été annulé.",
    alarm: "Rappel : votre rendez-vous chez Hair Simo",
    location: "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italie",
    feedName: "Hair Simo – Rendez-vous",
    feedDescription: "Agenda des rendez-vous Hair Simo, mis à jour automatiquement.",
  },
  en: {
    colon: ": ",
    appointment: "Appointment",
    service: "Service",
    team: "Team",
    customer: "Customer",
    when: "Appointment",
    address: "Address",
    phone: "Phone",
    note: "Note",
    manage: "Manage appointment",
    reason: "Reason",
    cancelledPrefix: "Cancelled",
    cancelledNotice: "This appointment has been cancelled.",
    alarm: "Reminder: your Hair Simo appointment",
    location: "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italy",
    feedName: "Hair Simo – Appointments",
    feedDescription: "Hair Simo appointment calendar, refreshed automatically.",
  },
};

export type IcsTimeMode = "tzid" | "utc";

export type IcsMethod = "REQUEST" | "CANCEL" | "PUBLISH";

export type IcsAppointmentInput = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  locale?: string | null;
  status?: AppointmentStatus | string | null;
  serviceName?: string | null;
  staffName?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  notes?: string | null;
  cancellationReason?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  manageUrl?: string | null;
};

export type IcsBuildOptions = {
  /** DTSTAMP. Pass a fixed value to make the output byte-for-byte reproducible. */
  now?: Date;
  /** Overrides {@link appointmentSequence}. Must never decrease for a given UID. */
  sequence?: number;
  organizerName?: string;
  organizerEmail?: string;
  productId?: string;
  uidDomain?: string;
  timeMode?: IcsTimeMode;
  /** Minutes before DTSTART for the VALARM. `null` or `0` emits no alarm. */
  alarmMinutesBefore?: number | null;
  /** Force the locale instead of taking it from the appointment record. */
  locale?: string | null;
};

export type StaffFeedOptions = Omit<IcsBuildOptions, "sequence"> & {
  calendarName?: string;
  calendarDescription?: string;
  refreshIntervalMinutes?: number;
  /**
   * `tombstone` (default) keeps cancelled appointments as STATUS:CANCELLED VEVENTs so
   * clients that only ever merge a feed still grey them out. `omit` drops them, which
   * relies on the client deleting events that vanished from the feed.
   */
  cancelledPolicy?: "omit" | "tombstone";
};

export type StaffFeedRange = { from?: Date; to?: Date; limit?: number };

export type StaffFeedResult = {
  staffId: string;
  staffName: string;
  calendar: string;
  filename: string;
  contentType: string;
  eventCount: number;
};

const icsAppointmentSchema = z.object({
  id: z.string().min(1),
  startsAt: z.date(),
  endsAt: z.date(),
  locale: z.string().nullish(),
  status: z.string().nullish(),
  serviceName: z.string().nullish(),
  staffName: z.string().nullish(),
  customerName: z.string().nullish(),
  customerEmail: z.string().nullish(),
  notes: z.string().nullish(),
  cancellationReason: z.string().nullish(),
  createdAt: z.date().nullish(),
  updatedAt: z.date().nullish(),
  manageUrl: z.string().nullish(),
});

type ParsedAppointment = z.infer<typeof icsAppointmentSchema>;

/**
 * Escape a TEXT value per RFC 5545 §3.3.11. Backslash first, otherwise the backslashes
 * introduced by the later replacements get escaped a second time. Control characters
 * other than the newline we are folding into `\n` are not representable and are dropped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(CONTROL_CHARS, "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/[;,]/g, (match) => `\\${match}`);
}

/**
 * Prepare a URI value. RFC 5545 §3.3.13 gives URI no content escaping at all, so running
 * a URL through {@link escapeIcsText} would leave a literal backslash in front of any
 * comma or semicolon and hand the client a broken link. Only the characters that could
 * end the content line are removed.
 */
function icsUriValue(value: string): string {
  return value.replace(CONTROL_CHARS, "").replace(/\r\n|\n|\r/g, "");
}

/** Escape a parameter value per RFC 6868 and quote it when it carries a separator. */
export function escapeIcsParam(value: string): string {
  const escaped = value
    .replace(CONTROL_CHARS, "")
    .replace(/\^/g, "^^")
    .replace(/\r\n|\n|\r/g, "^n")
    .replace(/"/g, "^'");
  return /[;:,]/.test(escaped) ? `"${escaped}"` : escaped;
}

/**
 * Fold a content line per RFC 5545 §3.1.
 *
 * The limit is 75 OCTETS, not characters, and a multi-octet UTF-8 sequence must not be
 * split. Service names ("Balayage & Strähnen") and the Italian address make that the
 * normal case here rather than an edge case, so the split point walks back off any
 * continuation byte. Continuation lines carry a leading space that counts towards the
 * limit, which is why every line after the first gets one octet less.
 */
export function foldIcsLine(line: string, maxOctets: number = MAX_LINE_OCTETS): string {
  const bytes = encoder.encode(line);
  if (bytes.length <= maxOctets) return line;

  const chunks: string[] = [];
  let offset = 0;
  let limit = maxOctets;

  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    chunks.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
    limit = maxOctets - 1;
  }

  return chunks.join("\r\n ");
}

function serialize(lines: string[]): string {
  return `${lines.map((line) => foldIcsLine(line)).join("\r\n")}\r\n`;
}

/**
 * Stable, idempotent UID. Re-sending the confirmation for the same appointment produces
 * the same UID, so a calendar client updates the existing event instead of adding a
 * second one, and a later CANCEL for that UID removes exactly the right event.
 */
export function appointmentUid(appointmentId: string, domain: string = ICS_UID_DOMAIN): string {
  const local = String(appointmentId).replace(UNSAFE_UID_CHARS, "");
  if (!local) throw new Error("ICS_INVALID_APPOINTMENT_ID");
  const host = String(domain).replace(UNSAFE_UID_CHARS, "");
  if (!host) throw new Error("ICS_INVALID_UID_DOMAIN");
  return `${local}@${host}`;
}

/**
 * A CAL-ADDRESS that is safe to interpolate after `mailto:`, or `null`.
 *
 * `ORGANIZER` and `ATTENDEE` are the only properties whose value is not run through
 * {@link escapeIcsText}, because an escaped address is not a valid URI. An address
 * carrying a CR/LF would therefore end the content line and let whatever follows be
 * parsed as a new property — calendar injection through a stored e-mail address.
 */
function calendarAddress(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return SAFE_CAL_ADDRESS.test(trimmed) ? trimmed : null;
}

/**
 * SEQUENCE derived from the row itself, because the schema has no sequence column.
 *
 * Seconds elapsed between `createdAt` and `updatedAt` is monotonically non-decreasing
 * (Prisma only ever moves `updatedAt` forward), stable while nothing changes — so a
 * re-sent confirmation does not bump it and clients stay quiet — and increases on every
 * reschedule. It stays inside the 32-bit range RFC 5545 allows for 68 years of row
 * lifetime, which no appointment reaches.
 */
export function appointmentSequence(appointment: {
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): number {
  const created = appointment.createdAt?.getTime();
  const updated = appointment.updatedAt?.getTime();
  if (created === undefined || updated === undefined) return 0;
  const seconds = Math.floor((updated - created) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, MAX_SEQUENCE);
}

function resolveTimeMode(requested?: IcsTimeMode): IcsTimeMode {
  if (requested === "utc") return "utc";
  return VTIMEZONE_COMPONENTS[SALON_TIME_ZONE] ? "tzid" : "utc";
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function utcStamp(instant: Date): string {
  const iso = instant.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/**
 * Salon wall clock as `YYYYMMDDTHHMMSS`.
 *
 * Every zone conversion in this codebase goes through `./time`, never through the host's
 * local zone, so the wall clock is read back out of `formatInSalonZone`. The "en" locale
 * resolves to en-GB with fixed numeric fields, which always renders as
 * `DD/MM/YYYY, HH:MM:SS`; the digit groups are pulled out positionally and a shape that
 * does not match throws rather than silently producing a wrong stamp.
 */
function salonStamp(instant: Date): string {
  const formatted = formatInSalonZone(instant, "en", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const groups = formatted.match(/\d+/g);
  if (!groups || groups.length !== 6) {
    throw new Error(`ICS_WALL_CLOCK_UNPARSEABLE: "${formatted}"`);
  }
  const [day, month, year, hour, minute, second] = groups as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return `${pad(Number(year), 4)}${pad(Number(month), 2)}${pad(Number(day), 2)}T${pad(Number(hour), 2)}${pad(Number(minute), 2)}${pad(Number(second), 2)}`;
}

function dateTimeLine(name: string, instant: Date, timeMode: IcsTimeMode): string {
  if (timeMode === "utc") return `${name}:${utcStamp(instant)}`;
  return `${name};TZID=${escapeIcsParam(SALON_TIME_ZONE)}:${salonStamp(instant)}`;
}

/**
 * DTSTART/DTEND as a pair, because they have to stay ordered.
 *
 * On the October fall-back Sunday two distinct instants share one wall clock, so an event
 * inside that hour would serialise with DTEND equal to or before DTSTART, which RFC 5545
 * forbids and clients render as a zero-length event. That event alone falls back to
 * unambiguous UTC stamps; `endsAt > startsAt` is already guaranteed, so UTC is always
 * strictly ordered.
 */
function eventTimeLines(start: Date, end: Date, timeMode: IcsTimeMode): [string, string] {
  if (timeMode === "tzid" && salonStamp(end) <= salonStamp(start)) {
    return [dateTimeLine("DTSTART", start, "utc"), dateTimeLine("DTEND", end, "utc")];
  }
  return [dateTimeLine("DTSTART", start, timeMode), dateTimeLine("DTEND", end, timeMode)];
}

function alarmTrigger(minutes: number): string {
  if (minutes % 60 === 0) return `-PT${minutes / 60}H`;
  return `-PT${minutes}M`;
}

function refreshDuration(minutes: number): string {
  if (minutes % 1440 === 0) return `P${minutes / 1440}D`;
  if (minutes % 60 === 0) return `PT${minutes / 60}H`;
  return `PT${minutes}M`;
}

const ICS_STATUS: Record<string, "TENTATIVE" | "CONFIRMED" | "CANCELLED"> = {
  pending: "TENTATIVE",
  confirmed: "CONFIRMED",
  completed: "CONFIRMED",
  no_show: "CONFIRMED",
  cancelled: "CANCELLED",
};

function icsStatus(status: string | null | undefined): "TENTATIVE" | "CONFIRMED" | "CANCELLED" {
  if (!status) return "CONFIRMED";
  return ICS_STATUS[status] ?? "CONFIRMED";
}

function organizerLine(name: string, email: string): string {
  return `ORGANIZER;CN=${escapeIcsParam(name)}:mailto:${email}`;
}

function attendeeLine(name: string | null, email: string): string {
  const params = [
    "ROLE=REQ-PARTICIPANT",
    "CUTYPE=INDIVIDUAL",
    // The booking is already agreed in our own system and nothing consumes iTIP replies,
    // so the invitation must not make Gmail or Outlook ask the customer to RSVP.
    "PARTSTAT=ACCEPTED",
    "RSVP=FALSE",
  ];
  if (name) params.unshift(`CN=${escapeIcsParam(name)}`);
  return `ATTENDEE;${params.join(";")}:mailto:${email}`;
}

function resolveOrganizer(options: IcsBuildOptions): { name: string; email: string } {
  const configured =
    options.organizerEmail?.trim() ||
    process.env.SALON_CALENDAR_ORGANIZER_EMAIL?.trim() ||
    process.env.GCP_GMAIL_SENDER?.trim() ||
    DEFAULT_ORGANIZER_EMAIL;
  const email = calendarAddress(configured) ?? DEFAULT_ORGANIZER_EMAIL;
  return { name: options.organizerName?.trim() || DEFAULT_ORGANIZER_NAME, email };
}

function parseAppointment(input: IcsAppointmentInput): ParsedAppointment {
  const parsed = icsAppointmentSchema.parse(input);
  if (parsed.endsAt.getTime() <= parsed.startsAt.getTime()) {
    throw new Error("ICS_INVALID_TIME_RANGE");
  }
  return parsed;
}

function label(strings: CalendarStrings, key: keyof CalendarStrings, value: string): string {
  return `${strings[key]}${strings.colon}${value}`;
}

type EventAudience = "customer" | "staff";

type EventContext = {
  audience: EventAudience;
  locale: AppLocale;
  now: Date;
  timeMode: IcsTimeMode;
  uidDomain: string;
  organizer: { name: string; email: string };
  sequence: number;
  alarmMinutesBefore: number | null;
  withAttendee: boolean;
};

function descriptionFor(appointment: ParsedAppointment, context: EventContext): string {
  const strings = CALENDAR_STRINGS[context.locale];
  const lines: string[] = [];
  const cancelled = icsStatus(appointment.status) === "CANCELLED";

  if (cancelled) lines.push(strings.cancelledNotice);
  if (appointment.serviceName) lines.push(label(strings, "service", appointment.serviceName));
  if (context.audience === "staff" && appointment.customerName) {
    lines.push(label(strings, "customer", appointment.customerName));
  }
  if (context.audience === "customer" && appointment.staffName) {
    lines.push(label(strings, "team", appointment.staffName));
  }
  lines.push(
    label(
      strings,
      "when",
      formatSalonTimeRange(appointment.startsAt, appointment.endsAt, context.locale),
    ),
  );
  if (context.audience === "customer") {
    lines.push(label(strings, "address", strings.location));
    lines.push(label(strings, "phone", SALON_PHONE));
  }
  // `Appointment.notes` is the back-office note field and may hold anything the salon
  // typed about the customer, so it goes to the staff feed only, never into a file that
  // is mailed to the customer.
  if (context.audience === "staff" && appointment.notes?.trim()) {
    lines.push(label(strings, "note", appointment.notes.trim()));
  }
  if (cancelled && appointment.cancellationReason?.trim()) {
    lines.push(label(strings, "reason", appointment.cancellationReason.trim()));
  }
  if (context.audience === "customer" && appointment.manageUrl?.trim()) {
    lines.push(label(strings, "manage", appointment.manageUrl.trim()));
  }

  return lines.join("\n");
}

function summaryFor(appointment: ParsedAppointment, context: EventContext): string {
  const strings = CALENDAR_STRINGS[context.locale];
  const service = appointment.serviceName?.trim() || strings.appointment;
  const base =
    context.audience === "staff" && appointment.customerName
      ? `${service} – ${appointment.customerName}`
      : `${service} – ${DEFAULT_ORGANIZER_NAME}`;
  if (icsStatus(appointment.status) === "CANCELLED") {
    return `${strings.cancelledPrefix}${strings.colon}${base}`;
  }
  return base;
}

function buildEventLines(appointment: ParsedAppointment, context: EventContext): string[] {
  const strings = CALENDAR_STRINGS[context.locale];
  const lines: string[] = ["BEGIN:VEVENT"];

  lines.push(`UID:${appointmentUid(appointment.id, context.uidDomain)}`);
  lines.push(`DTSTAMP:${utcStamp(context.now)}`);
  lines.push(...eventTimeLines(appointment.startsAt, appointment.endsAt, context.timeMode));
  lines.push(`SEQUENCE:${context.sequence}`);
  lines.push(`STATUS:${icsStatus(appointment.status)}`);
  lines.push("TRANSP:OPAQUE");
  lines.push(`SUMMARY:${escapeIcsText(summaryFor(appointment, context))}`);
  lines.push(`DESCRIPTION:${escapeIcsText(descriptionFor(appointment, context))}`);
  lines.push(`LOCATION:${escapeIcsText(strings.location)}`);
  lines.push(organizerLine(context.organizer.name, context.organizer.email));

  const attendeeEmail = context.withAttendee ? calendarAddress(appointment.customerEmail) : null;
  if (attendeeEmail) {
    lines.push(attendeeLine(appointment.customerName ?? null, attendeeEmail));
  }
  if (context.audience === "customer" && appointment.manageUrl?.trim()) {
    lines.push(`URL:${icsUriValue(appointment.manageUrl.trim())}`);
  }
  if (appointment.createdAt) lines.push(`CREATED:${utcStamp(appointment.createdAt)}`);
  if (appointment.updatedAt) lines.push(`LAST-MODIFIED:${utcStamp(appointment.updatedAt)}`);

  const alarm = context.alarmMinutesBefore;
  if (alarm !== null && alarm > 0 && icsStatus(appointment.status) !== "CANCELLED") {
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`TRIGGER:${alarmTrigger(Math.floor(alarm))}`);
    lines.push(`DESCRIPTION:${escapeIcsText(strings.alarm)}`);
    lines.push("END:VALARM");
  }

  lines.push("END:VEVENT");
  return lines;
}

function calendarHeader(productId: string, method: IcsMethod | null): string[] {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${escapeIcsText(productId)}`];
  lines.push("CALSCALE:GREGORIAN");
  if (method) lines.push(`METHOD:${method}`);
  return lines;
}

function timezoneLines(timeMode: IcsTimeMode): string[] {
  if (timeMode !== "tzid") return [];
  return VTIMEZONE_COMPONENTS[SALON_TIME_ZONE] ?? [];
}

function buildSingleEventCalendar(
  input: IcsAppointmentInput,
  options: IcsBuildOptions,
  intent: "invite" | "cancel",
): string {
  const appointment = parseAppointment(input);
  const locale = resolveLocale(options.locale ?? appointment.locale);
  const timeMode = resolveTimeMode(options.timeMode);
  const organizer = resolveOrganizer(options);
  const withAttendee = calendarAddress(appointment.customerEmail) !== null;

  // METHOD:REQUEST and METHOD:CANCEL are iTIP messages and require an attendee. Without
  // a customer e-mail address the file is just something to import, so it is published.
  const method: IcsMethod = withAttendee ? (intent === "cancel" ? "CANCEL" : "REQUEST") : "PUBLISH";

  const pinnedSequence = options.sequence;
  const baseSequence = pinnedSequence ?? appointmentSequence(appointment);
  const sequence =
    intent === "cancel"
      ? Math.min(baseSequence + (pinnedSequence === undefined ? 1 : 0), MAX_SEQUENCE)
      : baseSequence;

  const context: EventContext = {
    audience: "customer",
    locale,
    now: options.now ?? new Date(),
    timeMode,
    uidDomain: options.uidDomain ?? ICS_UID_DOMAIN,
    organizer,
    sequence,
    alarmMinutesBefore:
      options.alarmMinutesBefore === undefined ? DEFAULT_ALARM_MINUTES : options.alarmMinutesBefore,
    withAttendee,
  };

  const eventInput: ParsedAppointment =
    intent === "cancel" ? { ...appointment, status: "cancelled" } : appointment;

  return serialize([
    ...calendarHeader(options.productId ?? ICS_PRODUCT_ID, method),
    ...timezoneLines(timeMode),
    ...buildEventLines(eventInput, context),
    "END:VCALENDAR",
  ]);
}

/**
 * C1 — one VEVENT for the confirmation mail attachment (METHOD:REQUEST).
 *
 * ```ts
 * const ics = buildAppointmentIcs(
 *   {
 *     id: "appt_1",
 *     startsAt: new Date("2026-08-04T06:00:00.000Z"),
 *     endsAt: new Date("2026-08-04T07:15:00.000Z"),
 *     locale: "de",
 *     status: "confirmed",
 *     serviceName: "Balayage & Strähnen",
 *     staffName: "Simona",
 *     customerName: "Anna Müller",
 *     customerEmail: "anna@example.com",
 *     createdAt: new Date("2026-07-20T09:00:00.000Z"),
 *     updatedAt: new Date("2026-07-20T09:00:00.000Z"),
 *     manageUrl: "https://hairsimo.it/de/appointment/appt_1?token=…",
 *   },
 *   { now: new Date("2026-07-20T09:00:05.000Z") },
 * );
 * // attach as: filename ics filename, content type ICS_CONTENT_TYPE
 * ```
 */
export function buildAppointmentIcs(
  appointment: IcsAppointmentInput,
  options: IcsBuildOptions = {},
): string {
  return buildSingleEventCalendar(appointment, options, "invite");
}

/**
 * C3 — the cancellation counterpart (METHOD:CANCEL, STATUS:CANCELLED).
 *
 * The UID is identical to the invitation's, and SEQUENCE is one higher than whatever
 * {@link appointmentSequence} yields for the row, so the cancellation always supersedes
 * the invitation even when the row's `updatedAt` did not move. Pass `options.sequence`
 * explicitly to pin it; the +1 is only applied to the derived value.
 *
 * ```ts
 * const ics = buildCancellationIcs(appointment, { now: new Date() });
 * ```
 */
export function buildCancellationIcs(
  appointment: IcsAppointmentInput,
  options: IcsBuildOptions = {},
): string {
  return buildSingleEventCalendar(appointment, options, "cancel");
}

/**
 * C2 — a subscribable VCALENDAR for one staff member.
 *
 * No METHOD is emitted: a feed is not an iTIP message, and Outlook renders a file that
 * carries METHOD as a single invitation instead of importing a calendar. Alarms are off
 * by default so a subscription does not fire four notifications a day at the stylist.
 *
 * ```ts
 * const feed = buildStaffFeed(appointments, {
 *   calendarName: "Hair Simo – Simona",
 *   locale: "de",
 *   refreshIntervalMinutes: 60,
 * });
 * ```
 */
export function buildStaffFeed(
  appointments: IcsAppointmentInput[],
  options: StaffFeedOptions = {},
): string {
  const timeMode = resolveTimeMode(options.timeMode);
  const locale = resolveLocale(options.locale);
  const strings = CALENDAR_STRINGS[locale];
  const organizer = resolveOrganizer(options);
  const now = options.now ?? new Date();
  const refreshMinutes = Math.max(
    5,
    Math.floor(options.refreshIntervalMinutes ?? DEFAULT_REFRESH_MINUTES),
  );
  const cancelledPolicy = options.cancelledPolicy ?? "tombstone";
  const alarmMinutesBefore =
    options.alarmMinutesBefore === undefined ? null : options.alarmMinutesBefore;

  const lines = calendarHeader(options.productId ?? ICS_PRODUCT_ID, null);
  const calendarName = options.calendarName?.trim() || strings.feedName;
  const calendarDescription = options.calendarDescription?.trim() || strings.feedDescription;
  lines.push(`NAME:${escapeIcsText(calendarName)}`);
  lines.push(`X-WR-CALNAME:${escapeIcsText(calendarName)}`);
  lines.push(`DESCRIPTION:${escapeIcsText(calendarDescription)}`);
  lines.push(`X-WR-CALDESC:${escapeIcsText(calendarDescription)}`);
  lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${refreshDuration(refreshMinutes)}`);
  lines.push(`X-PUBLISHED-TTL:${refreshDuration(refreshMinutes)}`);
  if (timeMode === "tzid") lines.push(`X-WR-TIMEZONE:${escapeIcsText(SALON_TIME_ZONE)}`);
  lines.push(...timezoneLines(timeMode));

  for (const raw of appointments) {
    const appointment = parseAppointment(raw);
    const cancelled = icsStatus(appointment.status) === "CANCELLED";
    if (cancelled && cancelledPolicy === "omit") continue;
    const eventLocale = resolveLocale(options.locale ?? appointment.locale);
    lines.push(
      ...buildEventLines(appointment, {
        audience: "staff",
        locale: eventLocale,
        now,
        timeMode,
        uidDomain: options.uidDomain ?? ICS_UID_DOMAIN,
        organizer,
        sequence: appointmentSequence(appointment),
        alarmMinutesBefore,
        withAttendee: false,
      }),
    );
  }

  lines.push("END:VCALENDAR");
  return serialize(lines);
}

/** Suggested attachment filename for a single-appointment file. */
export function icsFilename(appointmentId: string, prefix = "hair-simo"): string {
  return `${prefix}-${String(appointmentId).replace(UNSAFE_UID_CHARS, "")}.ics`;
}

const warnedSecretFallback = { value: false };

function feedSecret(): string {
  const dedicated = process.env.STAFF_FEED_TOKEN_SECRET?.trim();
  if (dedicated) return dedicated;
  const shared = process.env.JWT_SECRET?.trim();
  if (!shared) throw new Error("STAFF_FEED_TOKEN_SECRET_MISSING");
  if (!warnedSecretFallback.value) {
    warnedSecretFallback.value = true;
    console.warn(
      "[calendar:secret-fallback] STAFF_FEED_TOKEN_SECRET is not set, falling back to the " +
        "shared JWT_SECRET. Rotating JWT_SECRET then invalidates every staff calendar " +
        "subscription as well as every session.",
    );
  }
  return shared;
}

function feedSignature(staffId: string): string {
  return createHmac("sha256", feedSecret())
    .update(`${STAFF_FEED_TOKEN_VERSION}.${FEED_TOKEN_CONTEXT}.${staffId}`)
    .digest("base64url");
}

/**
 * C4 — the credential that lives in the feed URL.
 *
 * Shape: `v1.<staffId>.<base64url HMAC-SHA256>`. The staff id travels in clear (it is an
 * opaque cuid, and the calendar app is going to hold the whole URL anyway) so that
 * verification needs no database round trip and a request can be attributed in the logs
 * before anything is loaded. The 256-bit tag is what makes the URL unguessable.
 *
 * ```ts
 * const token = createStaffFeedToken("staff_1");
 * const url = staffFeedUrl("staff_1"); // .../api/calendar/staff/v1.staff_1.<sig>.ics
 * ```
 */
export function createStaffFeedToken(staffId: string): string {
  const id = String(staffId);
  if (!SAFE_TOKEN_ID.test(id)) throw new Error("STAFF_FEED_STAFF_ID_INVALID");
  return `${STAFF_FEED_TOKEN_VERSION}.${id}.${feedSignature(id)}`;
}

/**
 * Verify a feed token in constant time. Throws `STAFF_FEED_TOKEN_INVALID` for every
 * failure mode — wrong version, tampered id, tampered signature — so the error never
 * tells an attacker which half they got right.
 *
 * ## Revocation
 *
 * The tag is a pure function of the secret and the staff id, so there is no per-token
 * state to delete. Two levers exist today:
 *   1. rotate `STAFF_FEED_TOKEN_SECRET`, which revokes every staff feed at once, and
 *   2. deactivate the staff member's `User` row, which {@link buildStaffFeedForToken}
 *      checks on every request — this is the per-person lever, but it also logs them out
 *      of the back office.
 *
 * The proper fix is one column: `StaffProfile.calendarFeedTokenVersion Int @default(1)`.
 * Mix it into the HMAC input (`v1.<context>.<staffId>.<tokenVersion>`), have the route
 * load the profile and verify against the stored version, and bump the integer to revoke
 * exactly one subscription while leaving every other feed and the login untouched. That
 * turns verification into a database read, which is why it is not simulated here with a
 * lookup against a column that does not exist.
 */
export function verifyStaffFeedToken(token: string): { staffId: string } {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new Error(FEED_TOKEN_ERROR);
  const [version, staffId, signature] = parts as [string, string, string];
  if (version !== STAFF_FEED_TOKEN_VERSION) throw new Error(FEED_TOKEN_ERROR);
  if (!SAFE_TOKEN_ID.test(staffId)) throw new Error(FEED_TOKEN_ERROR);

  const expected = encoder.encode(feedSignature(staffId));
  const provided = encoder.encode(signature);
  if (expected.length !== provided.length) {
    timingSafeEqual(expected, expected);
    throw new Error(FEED_TOKEN_ERROR);
  }
  if (!timingSafeEqual(expected, provided)) throw new Error(FEED_TOKEN_ERROR);
  return { staffId };
}

/** Absolute subscription URL. `webcal://` is what makes desktop clients subscribe. */
export function staffFeedUrl(
  staffId: string,
  baseUrl: string = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000",
  scheme: "https" | "webcal" = "https",
): string {
  const token = createStaffFeedToken(staffId);
  const normalized = baseUrl.replace(/\/+$/, "");
  const withScheme =
    scheme === "webcal" ? normalized.replace(/^https?:/, "webcal:") : normalized;
  return `${withScheme}/api/calendar/staff/${token}.ics`;
}

const appointmentSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  locale: true,
  status: true,
  notes: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  service: { select: { slug: true, translations: { select: { locale: true, name: true } } } },
  staff: { select: { displayName: true } },
  customer: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
      deletedAt: true,
      anonymizedAt: true,
    },
  },
} as const;

type AppointmentRow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  locale: string;
  status: AppointmentStatus;
  notes: string | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  service: { slug: string; translations: { locale: string; name: string }[] } | null;
  staff: { displayName: string } | null;
  customer: {
    firstName: string;
    lastName: string;
    email: string | null;
    deletedAt: Date | null;
    anonymizedAt: Date | null;
  } | null;
};

/** Map a Prisma appointment row onto the builder input. Exported for the route layer. */
export function toIcsAppointment(row: AppointmentRow): IcsAppointmentInput {
  const locale = resolveLocale(row.locale);
  const erased = Boolean(row.customer?.deletedAt || row.customer?.anonymizedAt);
  const customerName =
    row.customer && !erased ? `${row.customer.firstName} ${row.customer.lastName}`.trim() : null;
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    locale,
    status: row.status,
    serviceName: row.service
      ? getServiceTranslationName(row.service.translations, locale, row.service.slug)
      : null,
    staffName: row.staff?.displayName ?? null,
    customerName: customerName || null,
    customerEmail: row.customer && !erased ? row.customer.email : null,
    notes: row.notes,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Load one appointment in the shape {@link buildAppointmentIcs} expects. */
export async function loadAppointmentForIcs(
  appointmentId: string,
): Promise<IcsAppointmentInput | null> {
  const row = (await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: appointmentSelect,
  })) as AppointmentRow | null;
  return row ? toIcsAppointment(row) : null;
}

/**
 * Appointments for a staff feed. The window is bounded on purpose: calendar clients
 * re-download the whole document on every poll, so an unbounded history would grow into
 * a multi-megabyte response fetched several times a day.
 */
export async function loadStaffFeedAppointments(
  staffId: string,
  range: StaffFeedRange = {},
): Promise<IcsAppointmentInput[]> {
  const now = Date.now();
  const from = range.from ?? new Date(now - DEFAULT_FEED_PAST_DAYS * MS_PER_DAY);
  const to = range.to ?? new Date(now + DEFAULT_FEED_FUTURE_DAYS * MS_PER_DAY);
  const rows = (await prisma.appointment.findMany({
    where: { staffId, startsAt: { gte: from, lt: to } },
    orderBy: { startsAt: "asc" },
    take: Math.max(1, Math.min(range.limit ?? DEFAULT_FEED_LIMIT, DEFAULT_FEED_LIMIT)),
    select: appointmentSelect,
  })) as AppointmentRow[];
  return rows.map(toIcsAppointment);
}

/**
 * The whole feed request in one call: verify the URL token, check the staff member is
 * still active, load the window, serialise.
 *
 * ```ts
 * // apps/web/app/api/calendar/staff/[token]/route.ts
 * const feed = await buildStaffFeedForToken(token);
 * return new Response(feed.calendar, {
 *   headers: {
 *     "content-type": feed.contentType,
 *     "content-disposition": `inline; filename="${feed.filename}"`,
 *     "cache-control": "private, max-age=300",
 *   },
 * });
 * ```
 *
 * Throws `STAFF_FEED_TOKEN_INVALID` (map to 404, never 401 — a calendar client cannot
 * answer a challenge) or `STAFF_FEED_NOT_FOUND`.
 */
export async function buildStaffFeedForToken(
  token: string,
  options: StaffFeedOptions & { range?: StaffFeedRange } = {},
): Promise<StaffFeedResult> {
  const { staffId } = verifyStaffFeedToken(token);
  const staff = (await prisma.staffProfile.findUnique({
    where: { id: staffId },
    select: { id: true, displayName: true, locale: true, user: { select: { active: true } } },
  })) as { id: string; displayName: string; locale: string; user: { active: boolean } | null } | null;

  if (!staff || !staff.user?.active) throw new Error("STAFF_FEED_NOT_FOUND");

  const locale = resolveLocale(options.locale ?? staff.locale);
  const appointments = await loadStaffFeedAppointments(staffId, options.range);
  const calendarName =
    options.calendarName?.trim() ||
    `${CALENDAR_STRINGS[locale].feedName} – ${staff.displayName}`;
  const calendar = buildStaffFeed(appointments, { ...options, locale, calendarName });

  return {
    staffId,
    staffName: staff.displayName,
    calendar,
    filename: `hair-simo-${staffId}.ics`,
    contentType: ICS_CONTENT_TYPE,
    eventCount: appointments.filter(
      (appointment) =>
        (options.cancelledPolicy ?? "tombstone") === "tombstone" ||
        icsStatus(appointment.status) !== "CANCELLED",
    ).length,
  };
}
