import { z } from "zod";
import type { SupportedLocale, ToolChannel } from "./index";

/**
 * The tool layer of the public assistant.
 *
 * /api/chat/{web,sms,whatsapp} and /api/voice/dialogflow are unauthenticated, so every
 * argument that arrives here was written either by a language model or by whoever is
 * talking to it. The rules this module enforces:
 *
 *  - tool arguments carry INTENT ONLY. No appointment id, no customer id, no price, no
 *    staff assignment and no access token is ever taken from the model.
 *  - cancel and reschedule act on the appointment named by a VERIFIED appointment access
 *    token and on nothing else. A token for appointment A cannot reach appointment B.
 *  - creating an appointment needs a server generated confirmation code that the customer
 *    was read back, plus explicit consent, and the consent is recorded.
 *  - the server owns price, deposit and slot validity, re-checked at execution time.
 *  - mutating tools are rate limited per conversation, on top of the HTTP limit.
 *
 * It deliberately has no database import: @hair-simo/ai depends on zod and @hair-simo/i18n
 * only. The data operations are a port (`BookingBackend`) that apps/web implements with
 * @hair-simo/core, which also keeps this file testable without Prisma and keeps the
 * package importable from a client bundle.
 */

export const MAX_SLOT_SUGGESTIONS = 5;
export const MAX_SERVICE_SUGGESTIONS = 8;
/** A half-hour conversation is a long one; after that the collected PII is dropped. */
export const DRAFT_TTL_MS = 30 * 60_000;
/** A read-back the customer heard ten minutes ago is not a confirmation of today's price. */
export const CONFIRMATION_TTL_MS = 10 * 60_000;
export const MAX_DRAFTS = 5_000;
export const MUTATION_WINDOW_MS = 10 * 60_000;
export const MAX_MUTATIONS_PER_CONVERSATION = 5;
export const CONFIRMATION_CODE_LENGTH = 8;

/** Unambiguous over a phone line: no I/1, no O/0. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;
const MINUTES_PER_HOUR = 60;

const SERVICE_REF = z.string().trim().min(1).max(100);
const DAY_KEY = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const CLOCK = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
const ISO_INSTANT = z.string().trim().max(40).datetime({ offset: true });
/** Names and free text are echoed back to the customer, so they are length bound here. */
const PERSON_NAME = z.string().trim().min(1).max(60);
const FREE_TEXT = z.string().trim().min(1).max(200);
const CONFIRMATION_CODE = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{6,12}$/, "expected the confirmation code from the read-back");

/**
 * One zod schema per tool, `.strict()` throughout. Anything that decides *whose* data is
 * touched or *what* it costs is either bound to the session or read from the database on
 * execution, so none of it appears here.
 */
export const toolArgSchemas = {
  getOpeningHours: z.object({}).strict(),
  getServiceInfo: z.object({ service: SERVICE_REF.optional() }).strict(),
  checkAvailability: z.object({ service: SERVICE_REF, day: DAY_KEY.optional() }).strict(),
  collectBookingDetails: z
    .object({
      service: SERVICE_REF.optional(),
      day: DAY_KEY.optional(),
      time: CLOCK.optional(),
      startsAt: ISO_INSTANT.optional(),
      firstName: PERSON_NAME.optional(),
      lastName: PERSON_NAME.optional(),
      email: z.string().trim().email().max(254).optional(),
      phone: z.string().trim().min(4).max(30).optional(),
      note: FREE_TEXT.optional(),
      marketingOptIn: z.boolean().optional(),
    })
    .strict(),
  confirmBooking: z
    .object({ confirmationCode: CONFIRMATION_CODE, consent: z.literal(true) })
    .strict(),
  getMyAppointment: z.object({}).strict(),
  rescheduleBooking: z
    .object({ day: DAY_KEY.optional(), time: CLOCK.optional(), startsAt: ISO_INSTANT.optional() })
    .strict(),
  cancelBooking: z.object({ reason: FREE_TEXT.optional() }).strict(),
};

export type ToolName = keyof typeof toolArgSchemas;
export const TOOL_NAMES = Object.keys(toolArgSchemas) as ToolName[];

/** Tools that write to the database. Never reachable from the regex fallback. */
export const MUTATING_TOOL_NAMES = [
  "confirmBooking",
  "rescheduleBooking",
  "cancelBooking",
] as const satisfies readonly ToolName[];

/** Tools that address an existing appointment and therefore need a verified token. */
export const TOKEN_BOUND_TOOL_NAMES = [
  "getMyAppointment",
  "rescheduleBooking",
  "cancelBooking",
] as const satisfies readonly ToolName[];

/**
 * The only tools the regex fallback may call. The fallback has no idea what the customer
 * actually said — "storno" matches inside "Stornobedingungen" — so it is restricted to
 * reads by construction, and the runtime check in `callFallbackTool` keeps that true
 * after someone extends this list without thinking.
 */
export const FALLBACK_TOOL_NAMES = [
  "getOpeningHours",
  "getServiceInfo",
  "checkAvailability",
] as const satisfies readonly ToolName[];

export type MutatingToolName = (typeof MUTATING_TOOL_NAMES)[number];
export type FallbackToolName = (typeof FALLBACK_TOOL_NAMES)[number];

export function isToolName(value: string): value is ToolName {
  return Object.prototype.hasOwnProperty.call(toolArgSchemas, value);
}

export function isMutatingTool(value: string): value is MutatingToolName {
  return (MUTATING_TOOL_NAMES as readonly string[]).includes(value);
}

export function isTokenBoundTool(value: string): boolean {
  return (TOKEN_BOUND_TOOL_NAMES as readonly string[]).includes(value);
}

export function isFallbackTool(value: string): value is FallbackToolName {
  return (FALLBACK_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * @hair-simo/gcp still declares the pre-booking tool surface to Gemini, so a live model
 * asks for `createBooking` and `serviceId`. Mapping the stale names onto the current ones
 * keeps those calls working, and `createBooking` deliberately lands on the tool that only
 * collects details: a stale declaration must not become a shortcut past the read-back.
 */
const TOOL_NAME_ALIASES: Record<string, ToolName> = {
  createBooking: "collectBookingDetails",
  bookAppointment: "collectBookingDetails",
  getAvailability: "checkAvailability",
  getSlots: "checkAvailability",
  getServicePrice: "getServiceInfo",
  getPrice: "getServiceInfo",
  getOpeningTimes: "getOpeningHours",
  getMyBooking: "getMyAppointment",
};

export function resolveToolName(raw: string): ToolName | null {
  const value = String(raw ?? "").trim();
  if (isToolName(value)) return value;
  return TOOL_NAME_ALIASES[value] ?? null;
}

export type ToolErrorCode =
  | "INVALID_ARGUMENTS"
  | "RATE_LIMITED"
  | "ACCESS_TOKEN_REQUIRED"
  | "ACCESS_TOKEN_INVALID"
  | "APPOINTMENT_NOT_FOUND"
  | "APPOINTMENT_NOT_CHANGEABLE"
  | "SERVICE_NOT_FOUND"
  | "DRAFT_INCOMPLETE"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_STALE"
  | "PRICE_CHANGED"
  | "SLOT_NOT_AVAILABLE"
  | "BOOKING_FAILED"
  | "BACKEND_UNAVAILABLE"
  | "UNKNOWN_TOOL";

export type ToolResult = {
  ok: boolean;
  tool: ToolName | "unknown";
  /** Customer-facing text in the session locale. Safe to hand to the model verbatim. */
  message: string;
  /** Structured mirror of `message` for a UI that wants to render more than a string. */
  data?: Record<string, unknown>;
  error?: ToolErrorCode;
};

export type Toolset = {
  [K in ToolName]: (args?: unknown) => Promise<ToolResult>;
};

/**
 * Argument keys the model is not allowed to decide. They are dropped instead of rejected
 * so a model working from a stale declaration still gets its call executed — against the
 * appointment the session token names, at the price the database holds.
 */
const DROPPED_ARG_KEYS = new Set([
  "appointmentId",
  "appointment_id",
  "id",
  "customerId",
  "customer_id",
  "staffId",
  "staff_id",
  "accessToken",
  "access_token",
  "token",
  "conversationId",
  "conversation_id",
  "locale",
  "channel",
  "price",
  "priceCents",
  "totalCents",
  "depositCents",
  "amountCents",
  "currency",
  "status",
  "termsAccepted",
]);

const ARG_ALIASES: Record<string, string> = {
  serviceId: "service",
  serviceSlug: "service",
  service_slug: "service",
  service_id: "service",
  serviceName: "service",
  date: "day",
  dayKey: "day",
  salonDay: "day",
  start: "time",
  startTime: "time",
  start_time: "time",
  clock: "time",
  dateTime: "startsAt",
  datetime: "startsAt",
  starts_at: "startsAt",
  first_name: "firstName",
  given_name: "firstName",
  last_name: "lastName",
  family_name: "lastName",
  surname: "lastName",
  customerEmail: "email",
  mail: "email",
  customerPhone: "phone",
  telephone: "phone",
  comment: "note",
  notes: "note",
  code: "confirmationCode",
  confirmation_code: "confirmationCode",
  confirmationcode: "confirmationCode",
  confirmed: "consent",
  confirm: "consent",
  agree: "consent",
  accepted: "consent",
  cancellationReason: "reason",
};

function splitFullName(value: string): { firstName?: string; lastName?: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/**
 * LLMs improvise key names. Renaming the handful of predictable variants costs nothing and
 * saves a round trip, while `.strict()` still rejects everything genuinely unexpected.
 */
export function normalizeToolArgs(raw: unknown): {
  args: Record<string, unknown>;
  dropped: string[];
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { args: {}, dropped: [] };
  }
  const args: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (DROPPED_ARG_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    if (key === "name" && typeof value === "string") {
      const split = splitFullName(value);
      if (split.firstName !== undefined) args.firstName ??= split.firstName;
      if (split.lastName !== undefined) args.lastName ??= split.lastName;
      continue;
    }
    const target = ARG_ALIASES[key] ?? key;
    if (args[target] === undefined) args[target] = value;
  }

  return { args, dropped };
}

export type ToolArgs<K extends ToolName> = z.infer<(typeof toolArgSchemas)[K]>;

export type ParseToolArgsResult<K extends ToolName> =
  | { ok: true; args: ToolArgs<K>; dropped: string[] }
  | { ok: false; issues: string[]; dropped: string[] };

export function parseToolArgs<K extends ToolName>(name: K, raw: unknown): ParseToolArgsResult<K> {
  const { args, dropped } = normalizeToolArgs(raw);
  const parsed = toolArgSchemas[name].safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`);
    return { ok: false, issues, dropped };
  }
  return { ok: true, args: parsed.data as ToolArgs<K>, dropped };
}

/**
 * Gemini function declarations. They live next to the schemas so the tool surface has one
 * definition; @hair-simo/gcp still ships its own copy and has to be handed these instead
 * (see contractsForOtherAgents).
 */
export const toolDeclarations: Array<{
  name: ToolName;
  description: string;
  parameters: {
    type: "OBJECT";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}> = [
  {
    name: "getOpeningHours",
    description:
      "Opening hours and address of the salon, straight from the salon database. Always call this instead of quoting hours from memory.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "getServiceInfo",
    description:
      "Price, deposit and duration of one service, or the full price list when 'service' is omitted. Prices come from the database; never state a price the tool did not return.",
    parameters: {
      type: "OBJECT",
      properties: {
        service: { type: "STRING", description: "Service slug or name as the customer said it" },
      },
    },
  },
  {
    name: "checkAvailability",
    description: "Free appointment slots for a service on a salon day (Europe/Rome wall clock).",
    parameters: {
      type: "OBJECT",
      properties: {
        service: { type: "STRING", description: "Service slug or name" },
        day: { type: "STRING", description: "Salon day as YYYY-MM-DD, defaults to today" },
      },
      required: ["service"],
    },
  },
  {
    name: "collectBookingDetails",
    description:
      "Add or correct details of the booking in progress. Call it every time the customer supplies something new. It returns what is still missing, and once everything is there it returns the exact read-back plus a confirmationCode. Read that summary out to the customer word for word.",
    parameters: {
      type: "OBJECT",
      properties: {
        service: { type: "STRING", description: "Service slug or name" },
        day: { type: "STRING", description: "Salon day as YYYY-MM-DD" },
        time: { type: "STRING", description: "Salon wall clock as HH:MM, e.g. 14:30" },
        startsAt: { type: "STRING", description: "ISO instant; prefer day + time" },
        firstName: { type: "STRING", description: "Customer first name" },
        lastName: { type: "STRING", description: "Customer last name" },
        email: { type: "STRING", description: "Customer e-mail for the confirmation" },
        phone: { type: "STRING", description: "Optional phone number" },
        note: { type: "STRING", description: "Optional short note for the stylist" },
        marketingOptIn: { type: "BOOLEAN", description: "Only true if explicitly agreed" },
      },
    },
  },
  {
    name: "confirmBooking",
    description:
      "Create the appointment. Only call this after the customer has heard the read-back and said yes. Pass the confirmationCode returned by collectBookingDetails and consent true.",
    parameters: {
      type: "OBJECT",
      properties: {
        confirmationCode: { type: "STRING", description: "Code from the read-back" },
        consent: { type: "BOOLEAN", description: "True only when the customer agreed" },
      },
      required: ["confirmationCode", "consent"],
    },
  },
  {
    name: "getMyAppointment",
    description:
      "Details of the appointment this conversation is allowed to manage. Works only when the customer arrived through their personal manage link.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "rescheduleBooking",
    description:
      "Move the appointment this conversation is allowed to manage. There is no appointment id: the link the customer opened decides which appointment is affected.",
    parameters: {
      type: "OBJECT",
      properties: {
        day: { type: "STRING", description: "New salon day as YYYY-MM-DD" },
        time: { type: "STRING", description: "New salon wall clock as HH:MM" },
        startsAt: { type: "STRING", description: "ISO instant; prefer day + time" },
      },
    },
  },
  {
    name: "cancelBooking",
    description:
      "Cancel the appointment this conversation is allowed to manage. There is no appointment id: the link the customer opened decides which appointment is affected.",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING", description: "Short reason, optional" } },
    },
  },
];

export type ServiceSummary = {
  slug: string;
  name: string;
  durationMin: number;
  totalCents: number;
  depositCents: number;
  depositRequired: boolean;
};

export type BusinessDay = {
  dayOfWeek: number;
  isOpen: boolean;
  startMin: number;
  endMin: number;
};

export type AvailableSlot = {
  /** ISO instant. */
  startsAt: string;
  /** Salon wall clock, already formatted by the adapter that owns the time zone. */
  label: string;
};

export type AppointmentSummary = {
  id: string;
  customerId: string;
  startsAt: string;
  status: string;
  serviceSlug: string;
  serviceName: string;
  staffName?: string;
  /** Localised date and time range in the salon zone. */
  when: string;
};

export type CreateBookingInput = {
  serviceSlug: string;
  startsAt: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  note?: string;
  marketingOptIn?: boolean;
  locale: SupportedLocale;
  channel: ToolChannel;
};

export type ConsentInput = {
  customerId: string;
  type: string;
  granted: boolean;
  source: string;
};

/**
 * Everything the tools need from the outside world. All time-zone maths and all
 * formatting live behind it, because @hair-simo/core/time is the only sanctioned time
 * API and this package may not depend on it.
 */
export interface BookingBackend {
  listServices(locale: SupportedLocale): Promise<ServiceSummary[]>;
  findService(reference: string, locale: SupportedLocale): Promise<ServiceSummary | null>;
  listBusinessHours(): Promise<BusinessDay[]>;
  listAvailability(serviceSlug: string, dayKey: string): Promise<AvailableSlot[]>;
  /** "YYYY-MM-DD" of the current salon day. */
  todayKey(now: Date): string;
  /** "YYYY-MM-DD" of the salon day an ISO instant falls on. */
  dayKeyOf(instantIso: string): string;
  /** Salon day plus salon wall clock -> the ISO instant it denotes. Throws if invalid. */
  resolveInstant(dayKey: string, clock: string): string;
  verifyAccessToken(token: string): Promise<{ appointmentId: string; customerId: string }>;
  findAppointment(appointmentId: string, locale: SupportedLocale): Promise<AppointmentSummary | null>;
  createBooking(input: CreateBookingInput): Promise<AppointmentSummary>;
  rescheduleAppointment(
    appointmentId: string,
    startsAtIso: string,
    locale: SupportedLocale,
  ): Promise<AppointmentSummary>;
  cancelAppointment(
    appointmentId: string,
    reason: string,
    locale: SupportedLocale,
  ): Promise<AppointmentSummary>;
  recordConsent(input: ConsentInput): Promise<void>;
  formatInstant(instantIso: string, locale: SupportedLocale): string;
}

export type ToolLinks = {
  booking: (serviceSlug?: string) => string;
  services: () => string;
  manage: () => string;
};

export type SalonFacts = {
  address: string;
  phone: string;
  timeZone: string;
};

export type ToolSessionContext = {
  /** Server-derived. Two different callers must never share one. */
  conversationId: string;
  locale: SupportedLocale;
  channel: ToolChannel;
  /** Manage-link JWT supplied by the HTTP layer, never by the model, never prompted. */
  accessToken?: string;
};

export type BookingDraft = {
  conversationId: string;
  locale: SupportedLocale;
  channel: ToolChannel;
  serviceSlug?: string;
  serviceName?: string;
  day?: string;
  time?: string;
  startsAt?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  note?: string;
  marketingOptIn?: boolean;
  /** Quoted by the server when the confirmation code was issued, never by the model. */
  quotedTotalCents?: number;
  quotedDepositCents?: number;
  confirmationCode?: string;
  confirmationIssuedAt?: number;
  readBack?: string;
  createdAt: number;
  updatedAt: number;
};

export interface BookingDraftStore {
  get(conversationId: string, now: number): Promise<BookingDraft | null>;
  set(draft: BookingDraft): Promise<void>;
  delete(conversationId: string): Promise<void>;
}

/**
 * Process-local drafts. A booking in progress is worth at most half an hour of memory and
 * must not survive a restart: on a multi-instance deployment a customer whose second turn
 * lands elsewhere simply repeats the details, which is far better than putting half-filled
 * PII in a shared store with its own retention question.
 */
export class MemoryBookingDraftStore implements BookingDraftStore {
  private readonly entries = new Map<string, BookingDraft>();

  async get(conversationId: string, now: number): Promise<BookingDraft | null> {
    const draft = this.entries.get(conversationId);
    if (!draft) return null;
    if (now - draft.updatedAt > DRAFT_TTL_MS) {
      this.entries.delete(conversationId);
      return null;
    }
    return draft;
  }

  async set(draft: BookingDraft): Promise<void> {
    this.entries.delete(draft.conversationId);
    this.entries.set(draft.conversationId, draft);
    while (this.entries.size > MAX_DRAFTS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  async delete(conversationId: string): Promise<void> {
    this.entries.delete(conversationId);
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface ToolRateLimiter {
  consume(key: string, now: number): boolean;
}

/** Sliding window per conversation, independent of the per-address HTTP limit. */
export class MemoryToolRateLimiter implements ToolRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = MAX_MUTATIONS_PER_CONVERSATION,
    private readonly windowMs = MUTATION_WINDOW_MS,
  ) {}

  consume(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_DRAFTS) {
      const oldest = this.hits.keys().next();
      if (!oldest.done) this.hits.delete(oldest.value);
    }
    return true;
  }

  clear(): void {
    this.hits.clear();
  }
}

const sharedDrafts = new MemoryBookingDraftStore();
const sharedLimiter = new MemoryToolRateLimiter();

/** Test seam: drops every in-flight draft and rate-limit window. */
export function resetBookingToolState(): void {
  sharedDrafts.clear();
  sharedLimiter.clear();
}

type ReadBackInput = {
  service: string;
  when: string;
  name: string;
  email: string;
  phone?: string;
  total: string;
  deposit: string;
  note?: string;
};

type ToolCopy = {
  dayNames: readonly string[];
  openingHours: (open: string, closed: string, address: string, phone: string) => string;
  openingHoursStatic: (address: string, phone: string) => string;
  hoursUnavailable: (address: string, phone: string) => string;
  closedAllWeek: string;
  noSlots: (service: string, day: string, bookingHref: string) => string;
  slots: (count: number, preview: string, day: string, bookingHref: string) => string;
  availabilityFailed: (reason: string, bookingHref: string) => string;
  noServices: (servicesHref: string) => string;
  serviceInfo: (name: string, total: string, deposit: string, servicesHref: string) => string;
  serviceList: (lines: string, servicesHref: string) => string;
  serviceInfoFailed: (reason: string, servicesHref: string) => string;
  serviceUnknown: (reference: string, servicesHref: string) => string;
  fieldNames: Record<string, string>;
  missingDetails: (missing: string) => string;
  readBack: (input: ReadBackInput) => string;
  confirmPrompt: (code: string) => string;
  needDraft: string;
  needConfirmation: string;
  confirmationStale: string;
  priceChanged: string;
  slotTaken: (bookingHref: string) => string;
  bookingCreated: (service: string, when: string) => string;
  bookingFailed: (reason: string, bookingHref: string) => string;
  tokenRequired: string;
  tokenInvalid: string;
  appointmentNotFound: string;
  appointmentNotChangeable: (status: string) => string;
  appointmentDetails: (service: string, when: string, status: string) => string;
  rescheduleNeedsTime: string;
  rescheduled: (service: string, when: string) => string;
  cancelled: (service: string, when: string) => string;
  rateLimited: string;
  invalidArguments: string;
  backendUnavailable: string;
  unknownTool: string;
};

/**
 * Four-language customer-facing copy for every tool. It lives here rather than in the
 * apps/web adapter so that the security answers ("I need your personal link", "the price
 * changed") cannot drift between channels; the adapter supplies only the links and the
 * salon facts.
 */
const TOOL_COPY: Record<SupportedLocale, ToolCopy> = {
  de: {
    dayNames: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
    openingHours: (open, closed, address, phone) =>
      `Oeffnungszeiten: ${open}.${closed ? ` Geschlossen: ${closed}.` : ""} Adresse: ${address}. Telefon: ${phone}.`,
    openingHoursStatic: (address, phone) =>
      `Oeffnungszeiten (Standardzeiten, im System noch nicht hinterlegt): Di, Do, Fr 08:00-17:00, Mi und Sa 08:00-16:00, Montag und Sonntag geschlossen. Adresse: ${address}. Telefon: ${phone}.`,
    hoursUnavailable: (address, phone) =>
      `Die Oeffnungszeiten sind gerade nicht abrufbar. Adresse: ${address}. Telefon: ${phone}.`,
    closedAllWeek: "Aktuell sind keine Oeffnungszeiten hinterlegt.",
    noSlots: (service, day, bookingHref) =>
      `Fuer ${service} sind am ${day} leider keine freien Slots verfuegbar. Weitere Tage: ${bookingHref}`,
    slots: (count, preview, day, bookingHref) =>
      `Freie Slots fuer ${day} (${count}), Ortszeit Brixen: ${preview}. Buchung: ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Verfuegbarkeit gerade nicht abrufbar (${reason}). Bitte oeffne ${bookingHref}.`,
    noServices: (servicesHref) =>
      `Aktuell sind keine Leistungen hinterlegt. Bitte schau unter ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name}: Gesamt ${total} EUR, Anzahlung ${deposit} EUR. Details: ${servicesHref}`,
    serviceList: (lines, servicesHref) => `Unsere Leistungen:\n${lines}\nDetails: ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Preisinfo gerade nicht abrufbar (${reason}). Bitte oeffne ${servicesHref}.`,
    serviceUnknown: (reference, servicesHref) =>
      `Die Leistung "${reference}" kenne ich nicht. Unsere Leistungen: ${servicesHref}`,
    fieldNames: {
      service: "Leistung",
      startsAt: "Wunschtermin (Tag und Uhrzeit)",
      firstName: "Vorname",
      lastName: "Nachname",
      email: "E-Mail",
    },
    missingDetails: (missing) => `Dafuer brauche ich noch: ${missing}.`,
    readBack: (input) =>
      `Bitte pruefe: ${input.service} am ${input.when} fuer ${input.name}, E-Mail ${input.email}${input.phone ? `, Telefon ${input.phone}` : ""}${input.note ? `, Notiz: ${input.note}` : ""}. Gesamt ${input.total} EUR, Anzahlung ${input.deposit} EUR.`,
    confirmPrompt: (code) =>
      `Wenn das stimmt, antworte mit Ja - ich buche dann verbindlich mit dem Bestaetigungscode ${code} und speichere deine Zustimmung zu den AGB.`,
    needDraft: "Ich habe noch keine vollstaendige Buchung offen. Nenne mir Leistung, Termin, Name und E-Mail.",
    needConfirmation:
      "Diesen Bestaetigungscode habe ich nicht vergeben. Ich lese dir die Buchung noch einmal vor, danach bestaetige bitte.",
    confirmationStale:
      "Die Bestaetigung ist abgelaufen. Ich lese dir die Buchung noch einmal vor, danach bestaetige bitte erneut.",
    priceChanged:
      "Preis oder Anzahlung haben sich geaendert. Ich lese dir die aktualisierte Buchung vor, danach bestaetige bitte erneut.",
    slotTaken: (bookingHref) =>
      `Dieser Termin ist inzwischen vergeben. Ich suche dir gern eine Alternative, oder du waehlst direkt unter ${bookingHref}.`,
    bookingCreated: (service, when) =>
      `Gebucht: ${service} am ${when}. Die Bestaetigung mit deinem persoenlichen Termin-Link kommt per E-Mail.`,
    bookingFailed: (reason, bookingHref) =>
      `Die Buchung hat nicht geklappt (${reason}). Bitte versuche es unter ${bookingHref}.`,
    tokenRequired:
      "Dafuer brauche ich deinen persoenlichen Termin-Link aus der Bestaetigungsmail. Ohne diesen Link kann ich einen Termin weder verschieben noch absagen.",
    tokenInvalid:
      "Dieser Termin-Link ist abgelaufen oder ungueltig. Bitte oeffne den Link aus deiner aktuellen Bestaetigungsmail.",
    appointmentNotFound: "Zu diesem Link finde ich keinen Termin mehr.",
    appointmentNotChangeable: (status) =>
      `Dieser Termin hat den Status "${status}" und kann nicht mehr geaendert werden.`,
    appointmentDetails: (service, when, status) =>
      `Dein Termin: ${service} am ${when} (Status: ${status}).`,
    rescheduleNeedsTime: "Nenne mir bitte den neuen Tag und die neue Uhrzeit.",
    rescheduled: (service, when) => `Verschoben: ${service} jetzt am ${when}.`,
    cancelled: (service, when) => `Abgesagt: ${service} am ${when}.`,
    rateLimited:
      "Das waren zu viele Terminaenderungen in kurzer Zeit. Bitte melde dich in ein paar Minuten wieder oder ruf uns an.",
    invalidArguments: "Das habe ich nicht sauber verstanden. Bitte nenne es mir noch einmal.",
    backendUnavailable: "Das System antwortet gerade nicht. Bitte versuche es gleich noch einmal.",
    unknownTool: "Das kann ich hier nicht tun.",
  },
  it: {
    dayNames: ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"],
    openingHours: (open, closed, address, phone) =>
      `Orari: ${open}.${closed ? ` Chiuso: ${closed}.` : ""} Indirizzo: ${address}. Telefono: ${phone}.`,
    openingHoursStatic: (address, phone) =>
      `Orari (valori standard, non ancora registrati a sistema): mar, gio, ven 08:00-17:00, mer e sab 08:00-16:00, lunedi e domenica chiuso. Indirizzo: ${address}. Telefono: ${phone}.`,
    hoursUnavailable: (address, phone) =>
      `Gli orari non sono consultabili al momento. Indirizzo: ${address}. Telefono: ${phone}.`,
    closedAllWeek: "Al momento non ci sono orari registrati.",
    noSlots: (service, day, bookingHref) =>
      `Per ${service} il ${day} non ci sono orari liberi. Altri giorni: ${bookingHref}`,
    slots: (count, preview, day, bookingHref) =>
      `Orari liberi per ${day} (${count}), ora locale di Bressanone: ${preview}. Prenotazione: ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Disponibilita non consultabile al momento (${reason}). Apri ${bookingHref}.`,
    noServices: (servicesHref) =>
      `Al momento non ci sono servizi registrati. Dai un'occhiata a ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name}: totale ${total} EUR, acconto ${deposit} EUR. Dettagli: ${servicesHref}`,
    serviceList: (lines, servicesHref) => `I nostri servizi:\n${lines}\nDettagli: ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Informazioni sui prezzi non disponibili al momento (${reason}). Apri ${servicesHref}.`,
    serviceUnknown: (reference, servicesHref) =>
      `Il servizio "${reference}" non lo conosco. I nostri servizi: ${servicesHref}`,
    fieldNames: {
      service: "servizio",
      startsAt: "giorno e ora desiderati",
      firstName: "nome",
      lastName: "cognome",
      email: "e-mail",
    },
    missingDetails: (missing) => `Mi serve ancora: ${missing}.`,
    readBack: (input) =>
      `Controlla: ${input.service} il ${input.when} per ${input.name}, e-mail ${input.email}${input.phone ? `, telefono ${input.phone}` : ""}${input.note ? `, nota: ${input.note}` : ""}. Totale ${input.total} EUR, acconto ${input.deposit} EUR.`,
    confirmPrompt: (code) =>
      `Se e corretto rispondi si: prenoto con il codice di conferma ${code} e registro il tuo consenso alle condizioni.`,
    needDraft:
      "Non ho una prenotazione completa in corso. Dimmi servizio, data e ora, nome ed e-mail.",
    needConfirmation:
      "Questo codice di conferma non l'ho emesso io. Ti rileggo la prenotazione, poi conferma.",
    confirmationStale:
      "La conferma e scaduta. Ti rileggo la prenotazione, poi conferma di nuovo.",
    priceChanged:
      "Prezzo o acconto sono cambiati. Ti leggo la prenotazione aggiornata, poi conferma di nuovo.",
    slotTaken: (bookingHref) =>
      `Questo orario nel frattempo e stato preso. Ti cerco un'alternativa, oppure scegli su ${bookingHref}.`,
    bookingCreated: (service, when) =>
      `Prenotato: ${service} il ${when}. La conferma con il tuo link personale arriva per e-mail.`,
    bookingFailed: (reason, bookingHref) =>
      `La prenotazione non e riuscita (${reason}). Prova su ${bookingHref}.`,
    tokenRequired:
      "Per questo mi serve il tuo link personale dell'appuntamento, quello nella mail di conferma. Senza quel link non posso spostare ne annullare nulla.",
    tokenInvalid:
      "Questo link dell'appuntamento e scaduto o non valido. Apri il link della mail di conferma piu recente.",
    appointmentNotFound: "Con questo link non trovo piu nessun appuntamento.",
    appointmentNotChangeable: (status) =>
      `Questo appuntamento ha stato "${status}" e non e piu modificabile.`,
    appointmentDetails: (service, when, status) =>
      `Il tuo appuntamento: ${service} il ${when} (stato: ${status}).`,
    rescheduleNeedsTime: "Dimmi il nuovo giorno e il nuovo orario.",
    rescheduled: (service, when) => `Spostato: ${service} ora il ${when}.`,
    cancelled: (service, when) => `Annullato: ${service} del ${when}.`,
    rateLimited:
      "Troppe modifiche in poco tempo. Riprova tra qualche minuto oppure chiamaci.",
    invalidArguments: "Non ho capito bene. Puoi ripetermelo?",
    backendUnavailable: "Il sistema non risponde in questo momento. Riprova tra poco.",
    unknownTool: "Questo qui non posso farlo.",
  },
  fr: {
    dayNames: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    openingHours: (open, closed, address, phone) =>
      `Horaires : ${open}.${closed ? ` Ferme : ${closed}.` : ""} Adresse : ${address}. Telephone : ${phone}.`,
    openingHoursStatic: (address, phone) =>
      `Horaires (valeurs standard, pas encore enregistrees dans le systeme) : mar, jeu, ven 08:00-17:00, mer et sam 08:00-16:00, ferme lundi et dimanche. Adresse : ${address}. Telephone : ${phone}.`,
    hoursUnavailable: (address, phone) =>
      `Les horaires ne sont pas consultables pour le moment. Adresse : ${address}. Telephone : ${phone}.`,
    closedAllWeek: "Aucun horaire n'est enregistre pour le moment.",
    noSlots: (service, day, bookingHref) =>
      `Pour ${service} le ${day} il n'y a aucun creneau libre. Autres jours : ${bookingHref}`,
    slots: (count, preview, day, bookingHref) =>
      `Creneaux libres pour ${day} (${count}), heure locale de Bressanone : ${preview}. Reservation : ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Disponibilites indisponibles pour le moment (${reason}). Merci d'ouvrir ${bookingHref}.`,
    noServices: (servicesHref) =>
      `Aucune prestation n'est enregistree pour le moment. Consultez ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name} : total ${total} EUR, acompte ${deposit} EUR. Details : ${servicesHref}`,
    serviceList: (lines, servicesHref) => `Nos prestations :\n${lines}\nDetails : ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Tarifs indisponibles pour le moment (${reason}). Merci d'ouvrir ${servicesHref}.`,
    serviceUnknown: (reference, servicesHref) =>
      `Je ne connais pas la prestation "${reference}". Nos prestations : ${servicesHref}`,
    fieldNames: {
      service: "prestation",
      startsAt: "jour et heure souhaites",
      firstName: "prenom",
      lastName: "nom",
      email: "e-mail",
    },
    missingDetails: (missing) => `Il me manque encore : ${missing}.`,
    readBack: (input) =>
      `Verifiez : ${input.service} le ${input.when} pour ${input.name}, e-mail ${input.email}${input.phone ? `, telephone ${input.phone}` : ""}${input.note ? `, note : ${input.note}` : ""}. Total ${input.total} EUR, acompte ${input.deposit} EUR.`,
    confirmPrompt: (code) =>
      `Si c'est correct, repondez oui : je reserve avec le code de confirmation ${code} et j'enregistre votre accord aux conditions.`,
    needDraft:
      "Je n'ai pas de reservation complete en cours. Donnez-moi la prestation, la date et l'heure, le nom et l'e-mail.",
    needConfirmation:
      "Ce code de confirmation ne vient pas de moi. Je vous relis la reservation, puis confirmez.",
    confirmationStale:
      "La confirmation a expire. Je vous relis la reservation, puis confirmez a nouveau.",
    priceChanged:
      "Le tarif ou l'acompte a change. Je vous lis la reservation mise a jour, puis confirmez a nouveau.",
    slotTaken: (bookingHref) =>
      `Ce creneau vient d'etre pris. Je vous cherche une alternative, ou choisissez sur ${bookingHref}.`,
    bookingCreated: (service, when) =>
      `Reserve : ${service} le ${when}. La confirmation avec votre lien personnel arrive par e-mail.`,
    bookingFailed: (reason, bookingHref) =>
      `La reservation a echoue (${reason}). Merci d'essayer sur ${bookingHref}.`,
    tokenRequired:
      "Pour cela il me faut votre lien personnel de rendez-vous, celui du mail de confirmation. Sans ce lien je ne peux ni deplacer ni annuler.",
    tokenInvalid:
      "Ce lien de rendez-vous est expire ou invalide. Ouvrez le lien de votre dernier mail de confirmation.",
    appointmentNotFound: "Avec ce lien je ne trouve plus de rendez-vous.",
    appointmentNotChangeable: (status) =>
      `Ce rendez-vous a le statut "${status}" et ne peut plus etre modifie.`,
    appointmentDetails: (service, when, status) =>
      `Votre rendez-vous : ${service} le ${when} (statut : ${status}).`,
    rescheduleNeedsTime: "Indiquez-moi le nouveau jour et la nouvelle heure.",
    rescheduled: (service, when) => `Deplace : ${service} desormais le ${when}.`,
    cancelled: (service, when) => `Annule : ${service} du ${when}.`,
    rateLimited:
      "Cela fait trop de modifications en peu de temps. Reessayez dans quelques minutes ou appelez-nous.",
    invalidArguments: "Je n'ai pas bien compris. Pouvez-vous le redire ?",
    backendUnavailable: "Le systeme ne repond pas pour le moment. Reessayez dans un instant.",
    unknownTool: "Cela, je ne peux pas le faire ici.",
  },
  en: {
    dayNames: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    openingHours: (open, closed, address, phone) =>
      `Opening hours: ${open}.${closed ? ` Closed: ${closed}.` : ""} Address: ${address}. Phone: ${phone}.`,
    openingHoursStatic: (address, phone) =>
      `Opening hours (standard times, not yet stored in the system): Tue, Thu, Fri 08:00-17:00, Wed and Sat 08:00-16:00, closed Monday and Sunday. Address: ${address}. Phone: ${phone}.`,
    hoursUnavailable: (address, phone) =>
      `Opening hours are not reachable right now. Address: ${address}. Phone: ${phone}.`,
    closedAllWeek: "No opening hours are stored right now.",
    noSlots: (service, day, bookingHref) =>
      `There are no free slots for ${service} on ${day}. Other days: ${bookingHref}`,
    slots: (count, preview, day, bookingHref) =>
      `Free slots for ${day} (${count}), Brixen local time: ${preview}. Booking: ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Availability is not reachable right now (${reason}). Please open ${bookingHref}.`,
    noServices: (servicesHref) =>
      `No services are configured right now. Please check ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name}: total ${total} EUR, deposit ${deposit} EUR. Details: ${servicesHref}`,
    serviceList: (lines, servicesHref) => `Our services:\n${lines}\nDetails: ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Price info is not reachable right now (${reason}). Please open ${servicesHref}.`,
    serviceUnknown: (reference, servicesHref) =>
      `I do not know the service "${reference}". Our services: ${servicesHref}`,
    fieldNames: {
      service: "service",
      startsAt: "preferred day and time",
      firstName: "first name",
      lastName: "last name",
      email: "e-mail",
    },
    missingDetails: (missing) => `I still need: ${missing}.`,
    readBack: (input) =>
      `Please check: ${input.service} on ${input.when} for ${input.name}, e-mail ${input.email}${input.phone ? `, phone ${input.phone}` : ""}${input.note ? `, note: ${input.note}` : ""}. Total ${input.total} EUR, deposit ${input.deposit} EUR.`,
    confirmPrompt: (code) =>
      `If that is correct, reply yes: I will book it with confirmation code ${code} and record your agreement to the terms.`,
    needDraft:
      "I have no complete booking in progress. Tell me the service, the day and time, your name and e-mail.",
    needConfirmation:
      "That confirmation code is not one I issued. Let me read the booking back to you, then confirm.",
    confirmationStale:
      "That confirmation has expired. Let me read the booking back to you, then confirm again.",
    priceChanged:
      "The price or deposit changed. Let me read the updated booking back to you, then confirm again.",
    slotTaken: (bookingHref) =>
      `That slot has just been taken. I can look for an alternative, or pick one at ${bookingHref}.`,
    bookingCreated: (service, when) =>
      `Booked: ${service} on ${when}. The confirmation with your personal appointment link is on its way by e-mail.`,
    bookingFailed: (reason, bookingHref) =>
      `The booking did not go through (${reason}). Please try ${bookingHref}.`,
    tokenRequired:
      "For that I need your personal appointment link from the confirmation e-mail. Without that link I cannot move or cancel an appointment.",
    tokenInvalid:
      "That appointment link has expired or is invalid. Please open the link from your latest confirmation e-mail.",
    appointmentNotFound: "I cannot find an appointment for that link any more.",
    appointmentNotChangeable: (status) =>
      `That appointment is "${status}" and can no longer be changed.`,
    appointmentDetails: (service, when, status) =>
      `Your appointment: ${service} on ${when} (status: ${status}).`,
    rescheduleNeedsTime: "Please tell me the new day and the new time.",
    rescheduled: (service, when) => `Moved: ${service} is now on ${when}.`,
    cancelled: (service, when) => `Cancelled: ${service} on ${when}.`,
    rateLimited:
      "That is too many appointment changes in a short time. Please come back in a few minutes or call us.",
    invalidArguments: "I did not get that cleanly. Please tell me again.",
    backendUnavailable: "The system is not responding right now. Please try again in a moment.",
    unknownTool: "I cannot do that here.",
  },
};

export function toolCopyFor(locale: SupportedLocale): ToolCopy {
  return TOOL_COPY[locale] ?? TOOL_COPY.de;
}

const CHANGEABLE_STATUSES = new Set(["pending", "confirmed"]);
const REQUIRED_DRAFT_FIELDS = ["service", "startsAt", "firstName", "lastName", "email"] as const;
const DISPLAY_WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function euro(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function clock(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const rest = total % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "error";
}

function randomConfirmationCode(): string {
  const bytes = new Uint8Array(CONFIRMATION_CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/** Constant time for equal-length inputs; the length itself is not a secret. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export type BookingToolsetOptions = {
  backend: BookingBackend;
  session: ToolSessionContext;
  links?: ToolLinks;
  salon?: SalonFacts;
  drafts?: BookingDraftStore;
  limiter?: ToolRateLimiter;
  now?: () => Date;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

const DEFAULT_LINKS: ToolLinks = {
  booking: (serviceSlug) => (serviceSlug ? `/booking?service=${serviceSlug}` : "/booking"),
  services: () => "/services",
  manage: () => "/manage",
};

const DEFAULT_SALON: SalonFacts = {
  address: "Via Bastioni Maggiori 4/c, 39042 Brixen (Bressanone)",
  phone: "+39 0472 268402",
  timeZone: "Europe/Rome",
};

export function createBookingToolset(options: BookingToolsetOptions): Toolset {
  const { backend, session } = options;
  if (!CONVERSATION_ID_PATTERN.test(session.conversationId)) {
    throw new Error("INVALID_CONVERSATION_ID");
  }

  const locale = session.locale;
  const copy = toolCopyFor(locale);
  const links = options.links ?? DEFAULT_LINKS;
  const salon = options.salon ?? DEFAULT_SALON;
  const drafts = options.drafts ?? sharedDrafts;
  const limiter = options.limiter ?? sharedLimiter;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);

  const ok = (tool: ToolName, message: string, data?: Record<string, unknown>): ToolResult => ({
    ok: true,
    tool,
    message,
    ...(data ? { data } : {}),
  });

  const fail = (
    tool: ToolName,
    error: ToolErrorCode,
    message: string,
    data?: Record<string, unknown>,
  ): ToolResult => ({ ok: false, tool, error, message, ...(data ? { data } : {}) });

  function invalid(tool: ToolName, issues: string[]): ToolResult {
    log("assistant tool arguments rejected", { tool, issues });
    return fail(tool, "INVALID_ARGUMENTS", copy.invalidArguments, { issues });
  }

  function noteDropped(tool: ToolName, dropped: string[]): void {
    if (dropped.length === 0) return;
    log("assistant tool arguments dropped", {
      tool,
      dropped,
      conversationId: session.conversationId,
    });
  }

  /**
   * The gate every mutating tool passes. The type system already says the model cannot
   * name an appointment; this is the runtime half: the id comes out of verified claims,
   * the appointment must belong to the customer those claims name, and the per
   * conversation budget is spent here rather than in the HTTP layer.
   */
  async function requireAppointment(
    tool: ToolName,
  ): Promise<{ appointment: AppointmentSummary } | { failure: ToolResult }> {
    const token = session.accessToken?.trim();
    if (!token) {
      log("assistant tool refused without appointment token", {
        tool,
        conversationId: session.conversationId,
      });
      return { failure: fail(tool, "ACCESS_TOKEN_REQUIRED", copy.tokenRequired) };
    }

    let claims: { appointmentId: string; customerId: string };
    try {
      claims = await backend.verifyAccessToken(token);
    } catch (error) {
      log("assistant appointment token rejected", { tool, reason: reasonOf(error) });
      return { failure: fail(tool, "ACCESS_TOKEN_INVALID", copy.tokenInvalid) };
    }

    let appointment: AppointmentSummary | null;
    try {
      appointment = await backend.findAppointment(claims.appointmentId, locale);
    } catch (error) {
      return {
        failure: fail(tool, "BACKEND_UNAVAILABLE", copy.backendUnavailable, {
          reason: reasonOf(error),
        }),
      };
    }
    if (!appointment) {
      return { failure: fail(tool, "APPOINTMENT_NOT_FOUND", copy.appointmentNotFound) };
    }
    // Defence in depth: a token whose subject was re-assigned to another customer, or a
    // backend that ignored the id it was given, must not reach someone else's booking.
    if (appointment.id !== claims.appointmentId || appointment.customerId !== claims.customerId) {
      log("assistant appointment token binding mismatch", {
        tool,
        claimed: claims.appointmentId,
        resolved: appointment.id,
      });
      return { failure: fail(tool, "ACCESS_TOKEN_INVALID", copy.tokenInvalid) };
    }
    if (isMutatingTool(tool) && !CHANGEABLE_STATUSES.has(appointment.status)) {
      return {
        failure: fail(
          tool,
          "APPOINTMENT_NOT_CHANGEABLE",
          copy.appointmentNotChangeable(appointment.status),
        ),
      };
    }
    return { appointment };
  }

  function spendMutationBudget(tool: ToolName): ToolResult | null {
    if (!isMutatingTool(tool)) return null;
    if (limiter.consume(`chat-mutation:${session.conversationId}`, now().getTime())) return null;
    log("assistant mutating tool rate limited", {
      tool,
      conversationId: session.conversationId,
    });
    return fail(tool, "RATE_LIMITED", copy.rateLimited);
  }

  async function emptyDraft(): Promise<BookingDraft> {
    const timestamp = now().getTime();
    return {
      conversationId: session.conversationId,
      locale,
      channel: session.channel,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  function missingFields(draft: BookingDraft): string[] {
    return REQUIRED_DRAFT_FIELDS.filter((field) => {
      if (field === "service") return !draft.serviceSlug;
      if (field === "startsAt") return !draft.startsAt;
      return !draft[field];
    });
  }

  function buildReadBack(draft: BookingDraft, service: ServiceSummary): string {
    return copy.readBack({
      service: service.name,
      when: backend.formatInstant(draft.startsAt as string, locale),
      name: `${draft.firstName} ${draft.lastName}`,
      email: draft.email as string,
      phone: draft.phone,
      note: draft.note,
      total: euro(service.totalCents),
      deposit: euro(service.depositCents),
    });
  }

  /**
   * Issues the read-back and the code that `confirmBooking` will demand. The quote is
   * pinned onto the draft here, so a price or slot that moves afterwards is detectable
   * rather than silently charged.
   */
  async function issueConfirmation(
    draft: BookingDraft,
    service: ServiceSummary,
  ): Promise<{ draft: BookingDraft; readBack: string; code: string }> {
    const code = randomConfirmationCode();
    const readBack = buildReadBack(draft, service);
    const updated: BookingDraft = {
      ...draft,
      serviceName: service.name,
      quotedTotalCents: service.totalCents,
      quotedDepositCents: service.depositCents,
      confirmationCode: code,
      confirmationIssuedAt: now().getTime(),
      readBack,
      updatedAt: now().getTime(),
    };
    await drafts.set(updated);
    return { draft: updated, readBack, code };
  }

  async function slotIsFree(serviceSlug: string, startsAt: string): Promise<boolean> {
    const slots = await backend.listAvailability(serviceSlug, backend.dayKeyOf(startsAt));
    const target = new Date(startsAt).getTime();
    return slots.some((slot) => new Date(slot.startsAt).getTime() === target);
  }

  const tools: Toolset = {
    getOpeningHours: async (args) => {
      const parsed = parseToolArgs("getOpeningHours", args);
      if (!parsed.ok) return invalid("getOpeningHours", parsed.issues);

      let days: BusinessDay[];
      try {
        days = await backend.listBusinessHours();
      } catch (error) {
        return fail(
          "getOpeningHours",
          "BACKEND_UNAVAILABLE",
          copy.hoursUnavailable(salon.address, salon.phone),
          { reason: reasonOf(error) },
        );
      }

      // The salon edits BusinessHours in the admin; an empty table is a fresh install, not
      // a closed salon, so the static times are used and explicitly marked as such.
      if (days.length === 0) {
        return ok("getOpeningHours", copy.openingHoursStatic(salon.address, salon.phone), {
          source: "static-fallback",
          address: salon.address,
          phone: salon.phone,
        });
      }

      const byDay = new Map(days.map((entry) => [entry.dayOfWeek, entry]));
      const open: string[] = [];
      const closed: string[] = [];
      for (const dayOfWeek of DISPLAY_WEEK_ORDER) {
        const entry = byDay.get(dayOfWeek);
        const name = copy.dayNames[dayOfWeek];
        if (!entry || !entry.isOpen) {
          closed.push(name);
          continue;
        }
        open.push(`${name} ${clock(entry.startMin)}-${clock(entry.endMin)}`);
      }

      const message =
        open.length === 0
          ? copy.closedAllWeek
          : copy.openingHours(open.join(", "), closed.join(", "), salon.address, salon.phone);
      return ok("getOpeningHours", message, {
        source: "business-hours",
        days: days.map((entry) => ({
          dayOfWeek: entry.dayOfWeek,
          isOpen: entry.isOpen,
          start: clock(entry.startMin),
          end: clock(entry.endMin),
        })),
        address: salon.address,
        phone: salon.phone,
        timeZone: salon.timeZone,
      });
    },

    getServiceInfo: async (args) => {
      const parsed = parseToolArgs("getServiceInfo", args);
      if (!parsed.ok) return invalid("getServiceInfo", parsed.issues);
      noteDropped("getServiceInfo", parsed.dropped);
      const servicesHref = links.services();

      try {
        if (parsed.args.service) {
          const service = await backend.findService(parsed.args.service, locale);
          if (!service) {
            return fail(
              "getServiceInfo",
              "SERVICE_NOT_FOUND",
              copy.serviceUnknown(parsed.args.service, servicesHref),
            );
          }
          return ok(
            "getServiceInfo",
            copy.serviceInfo(
              service.name,
              euro(service.totalCents),
              euro(service.depositCents),
              servicesHref,
            ),
            { service },
          );
        }

        const services = await backend.listServices(locale);
        if (services.length === 0) {
          return ok("getServiceInfo", copy.noServices(servicesHref), { services: [] });
        }
        const shortlist = services.slice(0, MAX_SERVICE_SUGGESTIONS);
        const lines = shortlist
          .map(
            (service) =>
              `- ${service.name}: ${euro(service.totalCents)} EUR (${service.durationMin} min)`,
          )
          .join("\n");
        return ok("getServiceInfo", copy.serviceList(lines, servicesHref), {
          services: shortlist,
        });
      } catch (error) {
        return fail(
          "getServiceInfo",
          "BACKEND_UNAVAILABLE",
          copy.serviceInfoFailed(reasonOf(error), servicesHref),
        );
      }
    },

    checkAvailability: async (args) => {
      const parsed = parseToolArgs("checkAvailability", args);
      if (!parsed.ok) return invalid("checkAvailability", parsed.issues);
      noteDropped("checkAvailability", parsed.dropped);

      try {
        const service = await backend.findService(parsed.args.service, locale);
        if (!service) {
          return fail(
            "checkAvailability",
            "SERVICE_NOT_FOUND",
            copy.serviceUnknown(parsed.args.service, links.services()),
          );
        }
        const bookingHref = links.booking(service.slug);
        const day = parsed.args.day ?? backend.todayKey(now());
        const slots = await backend.listAvailability(service.slug, day);
        if (slots.length === 0) {
          return ok("checkAvailability", copy.noSlots(service.name, day, bookingHref), {
            service: service.slug,
            day,
            slots: [],
          });
        }
        const preview = slots
          .slice(0, MAX_SLOT_SUGGESTIONS)
          .map((slot) => slot.label)
          .join(", ");
        return ok("checkAvailability", copy.slots(slots.length, preview, day, bookingHref), {
          service: service.slug,
          day,
          slots: slots.slice(0, MAX_SLOT_SUGGESTIONS),
        });
      } catch (error) {
        return fail(
          "checkAvailability",
          "BACKEND_UNAVAILABLE",
          copy.availabilityFailed(reasonOf(error), links.booking()),
        );
      }
    },

    collectBookingDetails: async (args) => {
      const parsed = parseToolArgs("collectBookingDetails", args);
      if (!parsed.ok) return invalid("collectBookingDetails", parsed.issues);
      noteDropped("collectBookingDetails", parsed.dropped);

      const input = parsed.args;
      const existing = await drafts.get(session.conversationId, now().getTime());
      const draft: BookingDraft = { ...(existing ?? (await emptyDraft())) };
      draft.locale = locale;
      draft.channel = session.channel;
      draft.updatedAt = now().getTime();
      // Any edit invalidates the previous read-back: a code must never survive a change
      // the customer did not hear.
      draft.confirmationCode = undefined;
      draft.confirmationIssuedAt = undefined;
      draft.readBack = undefined;

      let service: ServiceSummary | null = null;
      try {
        if (input.service) {
          service = await backend.findService(input.service, locale);
          if (!service) {
            return fail(
              "collectBookingDetails",
              "SERVICE_NOT_FOUND",
              copy.serviceUnknown(input.service, links.services()),
            );
          }
          draft.serviceSlug = service.slug;
          draft.serviceName = service.name;
        } else if (draft.serviceSlug) {
          service = await backend.findService(draft.serviceSlug, locale);
        }

        if (input.startsAt) {
          draft.startsAt = input.startsAt;
          draft.day = backend.dayKeyOf(input.startsAt);
          draft.time = undefined;
        } else if (input.day !== undefined || input.time !== undefined) {
          draft.day = input.day ?? draft.day;
          draft.time = input.time ?? draft.time;
          draft.startsAt =
            draft.day && draft.time ? backend.resolveInstant(draft.day, draft.time) : undefined;
        }
      } catch (error) {
        return fail("collectBookingDetails", "BACKEND_UNAVAILABLE", copy.backendUnavailable, {
          reason: reasonOf(error),
        });
      }

      if (input.firstName) draft.firstName = input.firstName;
      if (input.lastName) draft.lastName = input.lastName;
      if (input.email) draft.email = input.email;
      if (input.phone) draft.phone = input.phone;
      if (input.note) draft.note = input.note;
      if (input.marketingOptIn !== undefined) draft.marketingOptIn = input.marketingOptIn;

      const missing = missingFields(draft);
      if (missing.length > 0 || !service) {
        await drafts.set(draft);
        const labels = (missing.length > 0 ? missing : ["service"]).map(
          (field) => copy.fieldNames[field] ?? field,
        );
        return ok("collectBookingDetails", copy.missingDetails(labels.join(", ")), {
          status: "incomplete",
          missing,
        });
      }

      try {
        if (!(await slotIsFree(draft.serviceSlug as string, draft.startsAt as string))) {
          draft.startsAt = undefined;
          draft.time = undefined;
          await drafts.set(draft);
          return fail(
            "collectBookingDetails",
            "SLOT_NOT_AVAILABLE",
            copy.slotTaken(links.booking(draft.serviceSlug)),
            { status: "slot_taken" },
          );
        }
      } catch (error) {
        return fail("collectBookingDetails", "BACKEND_UNAVAILABLE", copy.backendUnavailable, {
          reason: reasonOf(error),
        });
      }

      const issued = await issueConfirmation(draft, service);
      return ok(
        "collectBookingDetails",
        `${issued.readBack} ${copy.confirmPrompt(issued.code)}`,
        {
          status: "ready",
          readBack: issued.readBack,
          confirmationCode: issued.code,
          totalCents: service.totalCents,
          depositCents: service.depositCents,
          depositRequired: service.depositRequired,
        },
      );
    },

    confirmBooking: async (args) => {
      const parsed = parseToolArgs("confirmBooking", args);
      if (!parsed.ok) return invalid("confirmBooking", parsed.issues);
      noteDropped("confirmBooking", parsed.dropped);

      const limited = spendMutationBudget("confirmBooking");
      if (limited) return limited;

      const draft = await drafts.get(session.conversationId, now().getTime());
      if (!draft || missingFields(draft).length > 0) {
        return fail("confirmBooking", "DRAFT_INCOMPLETE", copy.needDraft);
      }
      if (!draft.confirmationCode || !draft.readBack) {
        return fail("confirmBooking", "CONFIRMATION_REQUIRED", copy.needConfirmation);
      }
      if (!safeEqual(draft.confirmationCode, parsed.args.confirmationCode)) {
        log("assistant confirmation code mismatch", { conversationId: session.conversationId });
        return fail("confirmBooking", "CONFIRMATION_REQUIRED", copy.needConfirmation);
      }
      if (now().getTime() - (draft.confirmationIssuedAt ?? 0) > CONFIRMATION_TTL_MS) {
        return fail("confirmBooking", "CONFIRMATION_STALE", copy.confirmationStale);
      }

      let service: ServiceSummary | null;
      try {
        service = await backend.findService(draft.serviceSlug as string, locale);
      } catch (error) {
        return fail("confirmBooking", "BACKEND_UNAVAILABLE", copy.backendUnavailable, {
          reason: reasonOf(error),
        });
      }
      if (!service) {
        return fail(
          "confirmBooking",
          "SERVICE_NOT_FOUND",
          copy.serviceUnknown(draft.serviceSlug ?? "", links.services()),
        );
      }

      // The read-back is a quote. If the price list moved between the read-back and the
      // yes, the customer agreed to a number that is no longer true.
      if (
        service.totalCents !== draft.quotedTotalCents ||
        service.depositCents !== draft.quotedDepositCents
      ) {
        const reissued = await issueConfirmation(draft, service);
        return fail(
          "confirmBooking",
          "PRICE_CHANGED",
          `${copy.priceChanged} ${reissued.readBack} ${copy.confirmPrompt(reissued.code)}`,
          { readBack: reissued.readBack, confirmationCode: reissued.code },
        );
      }

      try {
        if (!(await slotIsFree(draft.serviceSlug as string, draft.startsAt as string))) {
          return fail(
            "confirmBooking",
            "SLOT_NOT_AVAILABLE",
            copy.slotTaken(links.booking(draft.serviceSlug)),
          );
        }
      } catch (error) {
        return fail("confirmBooking", "BACKEND_UNAVAILABLE", copy.backendUnavailable, {
          reason: reasonOf(error),
        });
      }

      let appointment: AppointmentSummary;
      try {
        appointment = await backend.createBooking({
          serviceSlug: draft.serviceSlug as string,
          startsAt: draft.startsAt as string,
          firstName: draft.firstName as string,
          lastName: draft.lastName as string,
          email: draft.email as string,
          phone: draft.phone,
          note: draft.note,
          marketingOptIn: draft.marketingOptIn,
          locale,
          channel: session.channel,
        });
      } catch (error) {
        const reason = reasonOf(error);
        if (reason === "SLOT_NOT_AVAILABLE") {
          return fail(
            "confirmBooking",
            "SLOT_NOT_AVAILABLE",
            copy.slotTaken(links.booking(draft.serviceSlug)),
          );
        }
        return fail(
          "confirmBooking",
          "BOOKING_FAILED",
          copy.bookingFailed(reason, links.booking(draft.serviceSlug)),
        );
      }

      // The appointment exists at this point, so a failed consent write is logged rather
      // than turned into a booking failure the customer cannot act on. Agreement to the
      // terms themselves is recorded transactionally by the booking service.
      let consentRecorded = true;
      try {
        await backend.recordConsent({
          customerId: appointment.customerId,
          type: "assistant_readback",
          granted: true,
          source: `chat:${session.channel}`,
        });
      } catch (error) {
        consentRecorded = false;
        log("assistant consent record failed", {
          appointmentId: appointment.id,
          reason: reasonOf(error),
        });
      }

      await drafts.delete(session.conversationId);
      log("assistant created appointment", {
        appointmentId: appointment.id,
        channel: session.channel,
        conversationId: session.conversationId,
      });
      return ok("confirmBooking", copy.bookingCreated(appointment.serviceName, appointment.when), {
        appointmentId: appointment.id,
        startsAt: appointment.startsAt,
        readBack: draft.readBack,
        consentRecorded,
      });
    },

    getMyAppointment: async (args) => {
      const parsed = parseToolArgs("getMyAppointment", args);
      if (!parsed.ok) return invalid("getMyAppointment", parsed.issues);
      const resolved = await requireAppointment("getMyAppointment");
      if ("failure" in resolved) return resolved.failure;
      const { appointment } = resolved;
      return ok(
        "getMyAppointment",
        copy.appointmentDetails(appointment.serviceName, appointment.when, appointment.status),
        {
          startsAt: appointment.startsAt,
          service: appointment.serviceSlug,
          status: appointment.status,
          staff: appointment.staffName,
        },
      );
    },

    rescheduleBooking: async (args) => {
      const parsed = parseToolArgs("rescheduleBooking", args);
      if (!parsed.ok) return invalid("rescheduleBooking", parsed.issues);
      noteDropped("rescheduleBooking", parsed.dropped);

      const limited = spendMutationBudget("rescheduleBooking");
      if (limited) return limited;

      const resolved = await requireAppointment("rescheduleBooking");
      if ("failure" in resolved) return resolved.failure;
      const { appointment } = resolved;

      let startsAt: string;
      try {
        if (parsed.args.startsAt) {
          startsAt = parsed.args.startsAt;
        } else if (parsed.args.day && parsed.args.time) {
          startsAt = backend.resolveInstant(parsed.args.day, parsed.args.time);
        } else if (parsed.args.time) {
          startsAt = backend.resolveInstant(
            backend.dayKeyOf(appointment.startsAt),
            parsed.args.time,
          );
        } else {
          return fail("rescheduleBooking", "INVALID_ARGUMENTS", copy.rescheduleNeedsTime);
        }
      } catch (error) {
        return fail("rescheduleBooking", "INVALID_ARGUMENTS", copy.rescheduleNeedsTime, {
          reason: reasonOf(error),
        });
      }

      try {
        // The id is the verified one, never anything the model produced.
        const moved = await backend.rescheduleAppointment(appointment.id, startsAt, locale);
        log("assistant rescheduled appointment", { appointmentId: appointment.id });
        return ok("rescheduleBooking", copy.rescheduled(moved.serviceName, moved.when), {
          appointmentId: moved.id,
          startsAt: moved.startsAt,
        });
      } catch (error) {
        const reason = reasonOf(error);
        if (reason === "SLOT_NOT_AVAILABLE") {
          return fail(
            "rescheduleBooking",
            "SLOT_NOT_AVAILABLE",
            copy.slotTaken(links.booking(appointment.serviceSlug)),
          );
        }
        return fail(
          "rescheduleBooking",
          "BOOKING_FAILED",
          copy.bookingFailed(reason, links.manage()),
        );
      }
    },

    cancelBooking: async (args) => {
      const parsed = parseToolArgs("cancelBooking", args);
      if (!parsed.ok) return invalid("cancelBooking", parsed.issues);
      noteDropped("cancelBooking", parsed.dropped);

      const limited = spendMutationBudget("cancelBooking");
      if (limited) return limited;

      const resolved = await requireAppointment("cancelBooking");
      if ("failure" in resolved) return resolved.failure;
      const { appointment } = resolved;

      try {
        const cancelled = await backend.cancelAppointment(
          appointment.id,
          `chat:${session.channel}${parsed.args.reason ? ` - ${parsed.args.reason}` : ""}`,
          locale,
        );
        log("assistant cancelled appointment", { appointmentId: appointment.id });
        return ok("cancelBooking", copy.cancelled(cancelled.serviceName, cancelled.when), {
          appointmentId: cancelled.id,
        });
      } catch (error) {
        return fail(
          "cancelBooking",
          "BOOKING_FAILED",
          copy.bookingFailed(reasonOf(error), links.manage()),
        );
      }
    },
  };

  return tools;
}
