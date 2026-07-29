import { createHmac } from "node:crypto";
import { addMinutes } from "date-fns";
import { z } from "zod";
import { prisma } from "@hair-simo/db";
import { getServiceTranslationName, resolveLocale } from "@hair-simo/i18n";
import { timingSafeStringEqual } from "./auth-service";
import { NotificationService } from "./notification-service";
import { formatInSalonZone, formatSalonTimeRange } from "./time";
import type { Appointment, Channel, Waitlist } from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";
import type { DeliveryStatus } from "./notification-service";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * How long a notified customer keeps the exclusive right to a freed slot.
 *
 * The whole point of the waitlist is that a cancellation is worth money for a few hours
 * at most, so an offer that nobody answers has to fall back to the next person quickly.
 * Twenty minutes is long enough to read an SMS and click, short enough that a slot freed
 * at 09:00 can still be resold three times before lunch.
 */
export const DEFAULT_OFFER_TTL_MINUTES = 20;

/**
 * After an offer lapses unanswered, the same entry is not offered anything again for this
 * long. Without it a single unreachable customer at the head of a first-come queue would
 * be re-offered every freed slot forever and nobody behind them would ever be reached.
 * Losing a race is different: that customer answered, so `claim` clears `notifiedAt` and
 * they are eligible again immediately.
 */
export const DEFAULT_OFFER_COOLDOWN_MINUTES = 90;

/**
 * Deliberately shorter than `MIN_BOOKING_LEAD_MINUTES` (120) in booking-service. That lead
 * time protects the salon from a stranger claiming a chair the staff has not seen yet; a
 * waitlist offer is initiated by the salon's own cancellation, the chair is provably free,
 * and same-morning resale is exactly the revenue this feature exists to recover.
 */
export const DEFAULT_MIN_OFFER_LEAD_MINUTES = 60;

/** How many people are told about one freed slot. See `notifyMatches` for the semantics. */
export const DEFAULT_OFFERS_PER_SLOT = 3;

export const MAX_WAITLIST_WINDOW_DAYS = 30;
export const MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER = 5;
export const WAITLIST_HORIZON_DAYS = 180;

const MAX_CANDIDATE_SCAN = 200;
const OFFER_TOKEN_VERSION = "w1";
const SERIALIZABLE_TX_OPTIONS = {
  isolationLevel: "Serializable",
  maxWait: 5_000,
  timeout: 10_000,
} as const;
const SERIALIZATION_RETRY_ATTEMPTS = 5;
const SERIALIZATION_RETRY_BASE_DELAY_MS = 20;
const SERIALIZATION_RETRY_MAX_DELAY_MS = 400;
const SERIALIZATION_SQLSTATE_PATTERN =
  /\b(?:40001|40P01)\b|could not serialize access|deadlock detected/i;
const RETRYABLE_PRISMA_CODES = new Set(["P2034", "P2028"]);

export const WAITLIST_ERROR_CODES = [
  "INVALID_INPUT",
  "CUSTOMER_NOT_FOUND",
  "SERVICE_NOT_FOUND",
  "SERVICE_INACTIVE",
  "STAFF_NOT_FOUND",
  "STAFF_NOT_ELIGIBLE",
  "WINDOW_INVALID",
  "WINDOW_IN_PAST",
  "WINDOW_TOO_SHORT",
  "WINDOW_TOO_LONG",
  "WINDOW_TOO_FAR_AHEAD",
  "TOO_MANY_WAITLIST_ENTRIES",
  "ENTRY_NOT_FOUND",
  "ENTRY_CANCELLED",
  "OFFER_TOKEN_INVALID",
  "OFFER_SECRET_MISSING",
  "CLAIM_URL_NOT_CONFIGURED",
  "APPOINTMENT_NOT_FOUND",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_CUSTOMER_MISMATCH",
  "APPOINTMENT_SERVICE_MISMATCH",
  "ALREADY_CONVERTED",
] as const;

export type WaitlistErrorCode = (typeof WAITLIST_ERROR_CODES)[number];

/**
 * `message` is the code itself, matching the `throw new Error("SLOT_NOT_AVAILABLE")` style
 * the rest of core uses, while `code` gives the HTTP layer something to switch on without
 * string-matching a message.
 */
export class WaitlistError extends Error {
  readonly code: WaitlistErrorCode;

  constructor(code: WaitlistErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "WaitlistError";
    this.code = code;
  }
}

/**
 * A slot that just became bookable again: a cancellation, an appointment rescheduled away,
 * or newly opened staff availability. The end of the slot is never taken from the caller —
 * it is always `startsAt + service.durationMin`, so a stale or hand-written end time cannot
 * make the service offer a slot that does not fit the treatment.
 */
export type FreedSlot = {
  serviceId: string;
  staffId: string;
  startsAt: Date;
};

export type ResolvedSlot = {
  serviceId: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
};

/**
 * How an entry's [earliestAt, latestAt] window is compared to a freed slot.
 *
 * `contain` (default): the whole appointment must fit inside the window, boundaries
 * inclusive. "I can come between 09:00 and 12:00" with a 60 minute service accepts
 * 11:00-12:00 and rejects 11:30-12:30, which is what the customer actually meant.
 * `overlap`: any intersection counts. Only for admin tooling that wants to see everyone
 * who is vaguely interested; never use it to send offers.
 */
export type WaitlistWindowFit = "contain" | "overlap";

export type WaitlistBlockedReason =
  | "OFFER_IN_FLIGHT"
  | "OFFER_COOLDOWN"
  | "WINDOW_CLOSED"
  | "UNREACHABLE";

export type WaitlistCandidateEntry = Waitlist & {
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    locale: string;
  };
  service: {
    id: string;
    slug: string;
    durationMin: number;
    bufferAfterMin: number;
    translations: { locale: string; name: string }[];
  };
  staff: { id: string; displayName: string } | null;
};

export type NotifyTarget = { channel: Channel; recipient: string };

type SlotContext = { slot: ResolvedSlot; bufferAfterMin: number };

type ClaimTxResult =
  | { won: true; entry: Waitlist; appointment: Appointment }
  | { won: false; reason: WaitlistClaimFailure; appointmentId?: string };

export type WaitlistMatch = {
  entry: WaitlistCandidateEntry;
  /** 1-based position in the fairness order. Stable for identical inputs. */
  rank: number;
  offerable: boolean;
  blockedReason?: WaitlistBlockedReason;
  target: NotifyTarget | null;
};

export type WaitlistJoinResult = {
  entry: Waitlist;
  created: boolean;
  /** Set when an equivalent open entry already existed and was returned instead. */
  duplicateOf?: string;
  /**
   * Non-cancelled appointments this customer already holds for the same service inside the
   * requested window. Joining is still allowed — "I have Friday but I would rather come
   * earlier" is the single most common waitlist request — but the caller must show them.
   */
  heldAppointmentIds: string[];
};

export type WaitlistOfferOutcome = {
  entryId: string;
  customerId: string;
  locale: AppLocale;
  channel: Channel;
  recipient: string;
  token: string;
  claimUrl: string;
  status: DeliveryStatus;
  reason?: string;
};

export type WaitlistNotifyResult = {
  slot: ResolvedSlot;
  offerExpiresAt: Date;
  matched: number;
  offers: WaitlistOfferOutcome[];
  skipped: { entryId: string; reason: WaitlistBlockedReason | "OFFER_TAKEN_CONCURRENTLY" }[];
  /** Set when nothing was offered at all because the slot itself is not offerable. */
  aborted?: "SLOT_IN_PAST" | "SLOT_TOO_SOON" | "SLOT_TAKEN";
};

export type WaitlistClaimFailure =
  | "SLOT_TAKEN"
  | "SLOT_TOO_SOON"
  | "OFFER_EXPIRED"
  | "OFFER_NOT_ACTIVE"
  | "CUSTOMER_DOUBLE_BOOKED"
  | "CUSTOMER_UNAVAILABLE";

export type WaitlistClaimResult =
  | { won: true; entry: Waitlist; appointment: Appointment; alreadyClaimed: boolean }
  | { won: false; reason: WaitlistClaimFailure; conflictingAppointmentId?: string };

export type WaitlistExpireResult = {
  releasedOffers: number;
  expiredWindows: number;
  cancelledForErasedCustomers: number;
};

function envMinutes(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function offerTtlMinutes(): number {
  return envMinutes("WAITLIST_OFFER_TTL_MINUTES", DEFAULT_OFFER_TTL_MINUTES, 1, 24 * 60);
}

/**
 * Never shorter than the offer lifetime: the cooldown is what stops a live offer from
 * being handed to somebody else, so a smaller value would break exclusivity.
 */
export function offerCooldownMinutes(): number {
  return Math.max(
    offerTtlMinutes(),
    envMinutes("WAITLIST_OFFER_COOLDOWN_MINUTES", DEFAULT_OFFER_COOLDOWN_MINUTES, 1, 7 * 24 * 60),
  );
}

export function minOfferLeadMinutes(): number {
  return envMinutes("WAITLIST_MIN_LEAD_MINUTES", DEFAULT_MIN_OFFER_LEAD_MINUTES, 0, 24 * 60);
}

/**
 * When an offer stops being exclusive. Clamped to the slot start, because an offer that
 * outlives the appointment it is offering is not an offer.
 */
export function offerExpiresAt(notifiedAt: Date, slotStartsAt: Date): Date {
  return new Date(
    Math.min(notifiedAt.getTime() + offerTtlMinutes() * MS_PER_MINUTE, slotStartsAt.getTime()),
  );
}

function offerSecret(): string {
  const secret =
    process.env.WAITLIST_OFFER_SECRET ??
    process.env.APPOINTMENT_TOKEN_SECRET ??
    process.env.JWT_SECRET;
  if (!secret) throw new WaitlistError("OFFER_SECRET_MISSING");
  return secret;
}

function signOfferPayload(payload: string): string {
  return createHmac("sha256", offerSecret()).update(payload).digest("base64url");
}

export type WaitlistOfferClaims = {
  entryId: string;
  staffId: string;
  slotStartsAt: Date;
  notifiedAtMs: number;
};

function offerPayload(claims: WaitlistOfferClaims): string {
  return [
    OFFER_TOKEN_VERSION,
    claims.entryId,
    claims.staffId,
    String(claims.slotStartsAt.getTime()),
    String(claims.notifiedAtMs),
  ].join(".");
}

/**
 * Self-contained offer token. It carries the slot so the claim link needs no other query
 * parameter, and it is bound to `notifiedAt`, so re-offering the same entry silently
 * invalidates every token from the previous round. Nothing is stored: the Waitlist model
 * has no column for it, and an HMAC over data we can re-read needs none.
 */
export function createWaitlistOfferToken(claims: WaitlistOfferClaims): string {
  const payload = offerPayload(claims);
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signOfferPayload(payload)}`;
}

export function readWaitlistOfferToken(token: string): WaitlistOfferClaims | null {
  if (typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = Buffer.from(token.slice(0, separator), "base64url").toString("utf8");
  if (!timingSafeStringEqual(token.slice(separator + 1), signOfferPayload(payload))) return null;

  const fields = payload.split(".");
  if (fields.length !== 5 || fields[0] !== OFFER_TOKEN_VERSION) return null;
  const slotStartsAtMs = Number(fields[3]);
  const notifiedAtMs = Number(fields[4]);
  if (!Number.isFinite(slotStartsAtMs) || !Number.isFinite(notifiedAtMs)) return null;
  if (fields[1] === "" || fields[2] === "") return null;
  return {
    entryId: fields[1],
    staffId: fields[2],
    slotStartsAt: new Date(slotStartsAtMs),
    notifiedAtMs,
  };
}

function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && !RETRYABLE_PRISMA_CODES.has(code)) return false;
  if (typeof code === "string" && RETRYABLE_PRISMA_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && SERIALIZATION_SQLSTATE_PATTERN.test(message);
}

async function withSerializationRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SERIALIZATION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSerializationConflict(error)) throw error;
      lastError = error;
      if (attempt === SERIALIZATION_RETRY_ATTEMPTS - 1) break;
      const delay = Math.min(
        SERIALIZATION_RETRY_MAX_DELAY_MS,
        SERIALIZATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

type ServiceClient = Pick<typeof prisma, "service">;

type BlockingBounds = { spanMinutes: number; bufferMinutes: number };

/**
 * Kept byte-for-byte equivalent to `conflictWindowFilter` / `readBlockingBounds` in
 * repositories.ts. Both must read the same predicate over the same rows, otherwise
 * Postgres cannot see the read/write conflict between a waitlist claim and a normal
 * booking and the two would both be allowed to create the same slot.
 */
async function readBlockingBounds(client: ServiceClient): Promise<BlockingBounds> {
  const aggregate = await client.service.aggregate({
    _max: { durationMin: true, bufferAfterMin: true },
  });
  const bufferMinutes = aggregate._max.bufferAfterMin ?? 0;
  return { spanMinutes: (aggregate._max.durationMin ?? 0) + bufferMinutes, bufferMinutes };
}

function conflictWindowFilter(startsAt: Date, until: Date, bounds: BlockingBounds) {
  return {
    startsAt: { gte: addMinutes(startsAt, -bounds.spanMinutes), lt: until },
    endsAt: { gt: addMinutes(startsAt, -bounds.bufferMinutes) },
  };
}

const CANDIDATE_INCLUDE = {
  customer: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      locale: true,
    },
  },
  service: {
    select: {
      id: true,
      slug: true,
      durationMin: true,
      bufferAfterMin: true,
      translations: { select: { locale: true, name: true } },
    },
  },
  staff: { select: { id: true, displayName: true } },
} as const;

/**
 * `Channel` has no `email` member: Gmail delivery is spelled `web` and everything that
 * needs a phone number is normalised to `sms`, exactly as reminder-service does. A voice
 * waitlist entry is answered by SMS on purpose — a robocall about a slot that may be gone
 * in ten minutes is not something a salon should do to its customers.
 */
const CHANNEL_CONTACT: Record<Channel, "email" | "phone"> = {
  web: "email",
  whatsapp: "phone",
  sms: "phone",
  voice: "phone",
};

function resolveTarget(entry: WaitlistCandidateEntry): NotifyTarget | null {
  const email = entry.customer.email?.trim() || null;
  const phone = entry.customer.phone?.trim() || null;
  const preferred = CHANNEL_CONTACT[entry.channel];
  if (preferred === "phone" && phone) {
    return { channel: entry.channel === "voice" ? "sms" : entry.channel, recipient: phone };
  }
  if (preferred === "email" && email) return { channel: "web", recipient: email };
  if (email) return { channel: "web", recipient: email };
  if (phone) return { channel: "sms", recipient: phone };
  return null;
}

const OFFER_COPY: Record<AppLocale, { subject: string; body: string }> = {
  de: {
    subject: "Hair Simo: Termin frei geworden",
    body: "Guten Tag {{name}}, bei Hair Simo ist ein Termin frei geworden: {{time}} ({{service}}). Der Platz geht an die erste Bestätigung – bitte bis {{expires}} zusagen: {{link}}",
  },
  it: {
    subject: "Hair Simo: si è liberato un appuntamento",
    body: "Buongiorno {{name}}, da Hair Simo si è liberato un appuntamento: {{time}} ({{service}}). Il posto va a chi conferma per primo: conferma entro le {{expires}}: {{link}}",
  },
  fr: {
    subject: "Hair Simo : un créneau s'est libéré",
    body: "Bonjour {{name}}, un créneau vient de se libérer chez Hair Simo : {{time}} ({{service}}). La place revient à la première confirmation, à confirmer avant {{expires}} : {{link}}",
  },
  en: {
    subject: "Hair Simo: a slot has opened up",
    body: "Hello {{name}}, a slot has just opened up at Hair Simo: {{time}} ({{service}}). It goes to whoever confirms first — please confirm by {{expires}}: {{link}}",
  },
};

function claimUrlBase(locale: AppLocale, override?: string): string {
  const configured =
    override?.trim() ||
    process.env.WAITLIST_CLAIM_BASE_URL?.trim() ||
    (process.env.NEXT_PUBLIC_BASE_URL?.trim()
      ? `${process.env.NEXT_PUBLIC_BASE_URL.trim().replace(/\/+$/, "")}/${locale}/waitlist/claim`
      : "");
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") throw new WaitlistError("CLAIM_URL_NOT_CONFIGURED");
  return `http://localhost:3000/${locale}/waitlist/claim`;
}

function buildClaimUrl(base: string, entryId: string, token: string): string {
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}entry=${encodeURIComponent(entryId)}&token=${encodeURIComponent(token)}`;
}

const dateInput = z.union([z.string().trim().min(1), z.date()]).transform((value, ctx) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    ctx.addIssue({ code: "custom", message: "INVALID_DATE" });
    return z.NEVER;
  }
  return parsed;
});

const joinSchema = z
  .object({
    customerId: z.string().trim().min(1),
    serviceId: z.string().trim().min(1),
    staffId: z.string().trim().min(1).optional(),
    earliestAt: dateInput,
    latestAt: dateInput,
    locale: z.enum(["de", "it", "fr", "en"]).optional(),
    channel: z.enum(["web", "whatsapp", "sms", "voice"]).optional(),
  })
  .strict();

const freedSlotSchema = z
  .object({
    serviceId: z.string().trim().min(1),
    staffId: z.string().trim().min(1),
    startsAt: dateInput,
  })
  .strict();

function serviceLabel(entry: WaitlistCandidateEntry, locale: AppLocale): string {
  return getServiceTranslationName(entry.service.translations, locale, entry.service.slug);
}

export class WaitlistService {
  private notifications = new NotificationService();

  /**
   * W1 — put a customer on the list.
   *
   * Idempotent by design: an open entry of the same customer, for the same service, with
   * the same staff preference and an overlapping window is returned as-is instead of
   * stacking a second row, so a double-tapped form button cannot flood the queue. Genuinely
   * different windows are allowed up to `MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER`.
   */
  async join(rawInput: unknown, now = new Date()): Promise<WaitlistJoinResult> {
    const parsed = joinSchema.safeParse(rawInput);
    if (!parsed.success) throw new WaitlistError("INVALID_INPUT", parsed.error.message);
    const input = parsed.data;

    if (input.latestAt.getTime() <= input.earliestAt.getTime()) {
      throw new WaitlistError("WINDOW_INVALID");
    }
    if (input.latestAt.getTime() <= now.getTime()) throw new WaitlistError("WINDOW_IN_PAST");
    if (input.latestAt.getTime() - input.earliestAt.getTime() > MAX_WAITLIST_WINDOW_DAYS * MS_PER_DAY) {
      throw new WaitlistError("WINDOW_TOO_LONG");
    }
    if (input.latestAt.getTime() > now.getTime() + WAITLIST_HORIZON_DAYS * MS_PER_DAY) {
      throw new WaitlistError("WINDOW_TOO_FAR_AHEAD");
    }

    const [customer, service] = await Promise.all([
      prisma.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, locale: true, deletedAt: true, anonymizedAt: true },
      }),
      prisma.service.findUnique({
        where: { id: input.serviceId },
        select: { id: true, durationMin: true, isActive: true },
      }),
    ]);
    if (!customer || customer.deletedAt || customer.anonymizedAt) {
      throw new WaitlistError("CUSTOMER_NOT_FOUND");
    }
    if (!service) throw new WaitlistError("SERVICE_NOT_FOUND");
    if (!service.isActive) throw new WaitlistError("SERVICE_INACTIVE");

    // A window shorter than the treatment can never be satisfied, so it is rejected at the
    // door rather than sitting in the queue until it expires. The usable part of the window
    // starts now: a window that opened yesterday is fine, the past part is simply unusable.
    const usableFrom = Math.max(input.earliestAt.getTime(), now.getTime());
    if (input.latestAt.getTime() - usableFrom < service.durationMin * MS_PER_MINUTE) {
      throw new WaitlistError("WINDOW_TOO_SHORT");
    }

    if (input.staffId) {
      const staff = await prisma.staffProfile.findUnique({
        where: { id: input.staffId },
        select: {
          id: true,
          isBookable: true,
          staffServices: { where: { serviceId: input.serviceId }, select: { id: true } },
        },
      });
      if (!staff) throw new WaitlistError("STAFF_NOT_FOUND");
      if (!staff.isBookable || staff.staffServices.length === 0) {
        throw new WaitlistError("STAFF_NOT_ELIGIBLE");
      }
    }

    const locale = input.locale ?? resolveLocale(customer.locale);
    const staffId = input.staffId ?? null;

    const created = await withSerializationRetry(() =>
      prisma.$transaction(async (tx) => {
        const open = await tx.waitlist.findMany({
          where: {
            customerId: input.customerId,
            status: { in: ["active", "notified"] },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });

        const duplicate = open.find(
          (row) =>
            row.serviceId === input.serviceId &&
            row.staffId === staffId &&
            row.earliestAt.getTime() < input.latestAt.getTime() &&
            row.latestAt.getTime() > input.earliestAt.getTime(),
        );
        if (duplicate) return { entry: duplicate, created: false as const };

        if (open.length >= MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER) {
          throw new WaitlistError("TOO_MANY_WAITLIST_ENTRIES");
        }

        const entry = await tx.waitlist.create({
          data: {
            customerId: input.customerId,
            serviceId: input.serviceId,
            staffId,
            earliestAt: input.earliestAt,
            latestAt: input.latestAt,
            locale,
            channel: input.channel ?? "web",
          },
        });
        return { entry, created: true as const };
      }, SERIALIZABLE_TX_OPTIONS),
    );

    // W6, first half: joining while already holding a booking is legitimate ("I have
    // Friday, I would rather come Tuesday"), so it is reported and never rejected.
    const held = await prisma.appointment.findMany({
      where: {
        customerId: input.customerId,
        serviceId: input.serviceId,
        status: { not: "cancelled" },
        startsAt: { gte: input.earliestAt, lt: input.latestAt },
      },
      select: { id: true },
      orderBy: { startsAt: "asc" },
    });

    return {
      entry: created.entry,
      created: created.created,
      ...(created.created ? {} : { duplicateOf: created.entry.id }),
      heldAppointmentIds: held.map((row) => row.id),
    };
  }

  /** Withdraw an entry. Idempotent; a converted entry is never rolled back. */
  async cancel(entryId: string): Promise<Waitlist> {
    const entry = await prisma.waitlist.findUnique({ where: { id: entryId } });
    if (!entry) throw new WaitlistError("ENTRY_NOT_FOUND");
    if (entry.status === "cancelled" || entry.status === "converted") return entry;
    return prisma.waitlist.update({ where: { id: entryId }, data: { status: "cancelled" } });
  }

  private async resolveSlot(freedSlot: FreedSlot): Promise<SlotContext> {
    const parsed = freedSlotSchema.safeParse(freedSlot);
    if (!parsed.success) throw new WaitlistError("INVALID_INPUT", parsed.error.message);
    const service = await prisma.service.findUnique({
      where: { id: parsed.data.serviceId },
      select: { id: true, durationMin: true, bufferAfterMin: true, isActive: true },
    });
    if (!service) throw new WaitlistError("SERVICE_NOT_FOUND");
    if (!service.isActive) throw new WaitlistError("SERVICE_INACTIVE");
    return {
      slot: {
        serviceId: parsed.data.serviceId,
        staffId: parsed.data.staffId,
        startsAt: parsed.data.startsAt,
        endsAt: addMinutes(parsed.data.startsAt, service.durationMin),
      },
      bufferAfterMin: service.bufferAfterMin,
    };
  }

  /**
   * W2 — who could take this slot, in the order they are entitled to it.
   *
   * ORDERING RULE: strict first-come-first-served on `createdAt`, ties broken by `id`
   * (cuid, which is itself creation-ordered). Nothing else influences the order — not the
   * length of the window, not whether the customer named a staff member, not how much the
   * service costs. In a town where the customers know each other, "whoever asked first"
   * is the only rule the salon can defend across the counter, and the tie-break makes the
   * result byte-identical on every re-run.
   *
   * Returns every match, annotated. `offerable === false` entries are still returned so an
   * admin screen can show "3 waiting, 1 already offered"; `notifyMatches` only uses the
   * offerable ones.
   */
  async findMatches(
    freedSlot: FreedSlot,
    options: {
      now?: Date;
      limit?: number;
      windowFit?: WaitlistWindowFit;
      includeUnreachable?: boolean;
    } = {},
  ): Promise<WaitlistMatch[]> {
    const { slot } = await this.resolveSlot(freedSlot);
    const now = options.now ?? new Date();
    const fit = options.windowFit ?? "contain";
    const cooldownCutoff = new Date(now.getTime() - offerCooldownMinutes() * MS_PER_MINUTE);

    const windowFilter =
      fit === "contain"
        ? { earliestAt: { lte: slot.startsAt }, latestAt: { gte: slot.endsAt } }
        : { earliestAt: { lt: slot.endsAt }, latestAt: { gt: slot.startsAt } };

    const rows = (await prisma.waitlist.findMany({
      where: {
        serviceId: slot.serviceId,
        status: { in: ["active", "notified"] },
        OR: [{ staffId: null }, { staffId: slot.staffId }],
        customer: { deletedAt: null, anonymizedAt: null },
        ...windowFilter,
      },
      include: CANDIDATE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_CANDIDATE_SCAN,
    })) as WaitlistCandidateEntry[];

    const matches: WaitlistMatch[] = rows.map((entry, index) => {
      const target = resolveTarget(entry);
      const blockedReason = this.blockedReason(entry, slot, now, cooldownCutoff, target);
      return {
        entry,
        rank: index + 1,
        offerable: blockedReason === undefined,
        ...(blockedReason ? { blockedReason } : {}),
        target,
      };
    });

    const usable = options.includeUnreachable
      ? matches
      : matches.filter((match) => match.blockedReason !== "UNREACHABLE");
    return options.limit === undefined ? usable : usable.slice(0, Math.max(0, options.limit));
  }

  private blockedReason(
    entry: WaitlistCandidateEntry,
    slot: ResolvedSlot,
    now: Date,
    cooldownCutoff: Date,
    target: NotifyTarget | null,
  ): WaitlistBlockedReason | undefined {
    if (entry.latestAt.getTime() <= now.getTime()) return "WINDOW_CLOSED";
    if (!target) return "UNREACHABLE";
    if (entry.notifiedAt) {
      const live =
        entry.status === "notified" &&
        now.getTime() < offerExpiresAt(entry.notifiedAt, slot.startsAt).getTime();
      if (live) return "OFFER_IN_FLIGHT";
      if (entry.notifiedAt.getTime() >= cooldownCutoff.getTime()) return "OFFER_COOLDOWN";
    }
    return undefined;
  }

  /**
   * W3 — offer the slot.
   *
   * SEMANTICS, and they are deliberately blunt in the message text too: this is a RACE
   * between up to `limit` people, not a reservation for any of them. Each recipient gets a
   * token bound to (entry, slot, notifiedAt) that is worth exactly one attempt at
   * `claim`, and `claim` creates the appointment inside a serializable transaction, so
   * precisely one of them can win — including against a walk-in booking made through the
   * normal flow in the same second. The loser is told immediately and goes straight back
   * to the front of the queue with no cooldown.
   *
   * Offering to one person at a time would be fairer in theory; in practice a salon
   * cannot leave a Tuesday morning empty for twenty minutes per person on the list, and a
   * cohort of three converts fast enough to be worth the disappointment of two.
   *
   * Setting `limit: 1` degrades this to a strictly sequential exclusive offer for salons
   * that prefer it, with the next round handed out by `expire` + the next `notifyMatches`.
   */
  async notifyMatches(
    freedSlot: FreedSlot,
    options: {
      now?: Date;
      limit?: number;
      windowFit?: WaitlistWindowFit;
      claimUrlBase?: string;
    } = {},
  ): Promise<WaitlistNotifyResult> {
    const { slot, bufferAfterMin } = await this.resolveSlot(freedSlot);
    const now = options.now ?? new Date();
    const limit = Math.max(1, options.limit ?? DEFAULT_OFFERS_PER_SLOT);
    const expiresAt = offerExpiresAt(now, slot.startsAt);
    const empty: WaitlistNotifyResult = {
      slot,
      offerExpiresAt: expiresAt,
      matched: 0,
      offers: [],
      skipped: [],
    };

    if (slot.startsAt.getTime() <= now.getTime()) return { ...empty, aborted: "SLOT_IN_PAST" };
    if (slot.startsAt.getTime() - now.getTime() < minOfferLeadMinutes() * MS_PER_MINUTE) {
      return { ...empty, aborted: "SLOT_TOO_SOON" };
    }
    if (await this.slotIsTaken(prisma, slot, bufferAfterMin)) {
      return { ...empty, aborted: "SLOT_TAKEN" };
    }

    const matches = await this.findMatches(freedSlot, {
      now,
      windowFit: options.windowFit,
      includeUnreachable: true,
    });

    const offers: WaitlistOfferOutcome[] = [];
    const skipped: WaitlistNotifyResult["skipped"] = [];
    const cooldownCutoff = new Date(now.getTime() - offerCooldownMinutes() * MS_PER_MINUTE);

    for (const match of matches) {
      if (offers.length >= limit) break;
      if (!match.offerable || !match.target) {
        skipped.push({
          entryId: match.entry.id,
          reason: match.blockedReason ?? "UNREACHABLE",
        });
        continue;
      }

      // Compare-and-set: the WHERE clause re-checks under the row lock, so two cancellation
      // handlers racing on the same entry produce exactly one reservation. The cooldown
      // predicate is what makes a live offer untouchable, which is why the cooldown can
      // never be configured shorter than the offer lifetime.
      const previousNotifiedAt = match.entry.notifiedAt;
      const reserved = await prisma.waitlist.updateMany({
        where: {
          id: match.entry.id,
          status: { in: ["active", "notified"] },
          latestAt: { gt: now },
          OR: [{ notifiedAt: null }, { notifiedAt: { lt: cooldownCutoff } }],
        },
        data: { status: "notified", notifiedAt: now },
      });
      if (reserved.count === 0) {
        skipped.push({ entryId: match.entry.id, reason: "OFFER_TAKEN_CONCURRENTLY" });
        continue;
      }

      const locale = resolveLocale(match.entry.locale);
      const token = createWaitlistOfferToken({
        entryId: match.entry.id,
        staffId: slot.staffId,
        slotStartsAt: slot.startsAt,
        notifiedAtMs: now.getTime(),
      });
      const claimUrl = buildClaimUrl(
        claimUrlBase(locale, options.claimUrlBase),
        match.entry.id,
        token,
      );
      const copy = OFFER_COPY[locale];
      const message = copy.body
        .replace("{{name}}", match.entry.customer.firstName)
        .replace("{{time}}", formatSalonTimeRange(slot.startsAt, slot.endsAt, locale))
        .replace("{{service}}", serviceLabel(match.entry, locale))
        .replace(
          "{{expires}}",
          formatInSalonZone(expiresAt, locale, { hour: "2-digit", minute: "2-digit" }),
        )
        .replace("{{link}}", claimUrl);

      const delivery = await this.notifications.send({
        channel: match.target.channel,
        recipient: match.target.recipient,
        subject: copy.subject,
        message,
        locale,
      });

      // An offer nobody received must not burn the entry's turn, and must not start the
      // cooldown either, so the previous notifiedAt is restored rather than cleared.
      if (delivery.status === "failed") {
        await prisma.waitlist.update({
          where: { id: match.entry.id },
          data: { status: "active", notifiedAt: previousNotifiedAt },
        });
      }

      offers.push({
        entryId: match.entry.id,
        customerId: match.entry.customerId,
        locale,
        channel: match.target.channel,
        recipient: match.target.recipient,
        token,
        claimUrl,
        status: delivery.status,
        ...(delivery.reason ? { reason: delivery.reason } : {}),
      });
    }

    return {
      slot,
      offerExpiresAt: expiresAt,
      matched: matches.length,
      offers,
      skipped,
    };
  }

  private async slotIsTaken(
    client: Pick<typeof prisma, "service" | "appointment">,
    slot: ResolvedSlot,
    bufferAfterMin: number,
  ): Promise<boolean> {
    const bounds = await readBlockingBounds(client);
    const blockedEndsAt = addMinutes(slot.endsAt, bufferAfterMin);
    const candidates = await client.appointment.findMany({
      where: {
        staffId: slot.staffId,
        status: { not: "cancelled" },
        ...conflictWindowFilter(slot.startsAt, blockedEndsAt, bounds),
      },
      include: { service: { select: { bufferAfterMin: true } } },
    });
    return candidates.some(
      (item) => addMinutes(item.endsAt, item.service.bufferAfterMin) > slot.startsAt,
    );
  }

  /**
   * W4 — turn a live offer into a real appointment. Exactly one caller can win.
   *
   * The appointment row itself is the lock: the transaction reads the same conflict
   * predicate `salonRepository.createAppointmentIfAvailable` reads and then writes an
   * appointment, so Postgres' serializable checker aborts whichever of two concurrent
   * winners commits second — whether the other one is a second waitlist claim or a
   * stranger booking the slot through the normal web flow. The loser is retried, sees the
   * committed appointment and is told `SLOT_TAKEN`.
   *
   * Everything needed is inside the token, so the claim link carries no other parameter.
   */
  async claim(
    entryId: string,
    input: { token: string; now?: Date },
  ): Promise<WaitlistClaimResult> {
    const now = input.now ?? new Date();
    const claims = readWaitlistOfferToken(input.token);
    if (!claims) throw new WaitlistError("OFFER_TOKEN_INVALID");
    if (!timingSafeStringEqual(claims.entryId, entryId)) {
      throw new WaitlistError("OFFER_TOKEN_INVALID");
    }

    const entry = (await prisma.waitlist.findUnique({
      where: { id: entryId },
      include: CANDIDATE_INCLUDE,
    })) as WaitlistCandidateEntry | null;
    if (!entry) throw new WaitlistError("ENTRY_NOT_FOUND");

    const slot: ResolvedSlot = {
      serviceId: entry.serviceId,
      staffId: claims.staffId,
      startsAt: claims.slotStartsAt,
      endsAt: addMinutes(claims.slotStartsAt, entry.service.durationMin),
    };

    // A double-tapped confirmation link must show the booking, not an error.
    if (entry.status === "converted" && entry.convertedAppointmentId) {
      const existing = await prisma.appointment.findUnique({
        where: { id: entry.convertedAppointmentId },
      });
      if (existing && existing.startsAt.getTime() === slot.startsAt.getTime()) {
        return { won: true, entry, appointment: existing, alreadyClaimed: true };
      }
      return { won: false, reason: "OFFER_NOT_ACTIVE" };
    }

    if (
      entry.status !== "notified" ||
      !entry.notifiedAt ||
      entry.notifiedAt.getTime() !== claims.notifiedAtMs
    ) {
      return { won: false, reason: "OFFER_NOT_ACTIVE" };
    }
    if (now.getTime() >= offerExpiresAt(entry.notifiedAt, slot.startsAt).getTime()) {
      return { won: false, reason: "OFFER_EXPIRED" };
    }
    if (slot.startsAt.getTime() - now.getTime() < minOfferLeadMinutes() * MS_PER_MINUTE) {
      return { won: false, reason: "SLOT_TOO_SOON" };
    }

    const result = await withSerializationRetry<ClaimTxResult>(() =>
      prisma.$transaction(async (tx): Promise<ClaimTxResult> => {
        const current = await tx.waitlist.findUnique({
          where: { id: entryId },
          select: { status: true, notifiedAt: true },
        });
        if (
          !current ||
          current.status !== "notified" ||
          current.notifiedAt?.getTime() !== claims.notifiedAtMs
        ) {
          return { won: false, reason: "OFFER_NOT_ACTIVE" };
        }

        const bounds = await readBlockingBounds(tx);
        const blockedEndsAt = addMinutes(slot.endsAt, entry.service.bufferAfterMin);
        const staffConflicts = await tx.appointment.findMany({
          where: {
            staffId: slot.staffId,
            status: { not: "cancelled" },
            ...conflictWindowFilter(slot.startsAt, blockedEndsAt, bounds),
          },
          include: { service: { select: { bufferAfterMin: true } } },
        });
        const taken = staffConflicts.find(
          (item) => addMinutes(item.endsAt, item.service.bufferAfterMin) > slot.startsAt,
        );
        if (taken) return { won: false, reason: "SLOT_TAKEN" as const, appointmentId: taken.id };

        // W6, second half: the customer may already sit in another chair at that hour,
        // either because they were on the list for a slot they already held or because
        // they booked normally after joining. Never create the second appointment.
        const ownConflicts = await tx.appointment.findMany({
          where: {
            customerId: entry.customerId,
            status: { not: "cancelled" },
            startsAt: { gte: addMinutes(slot.startsAt, -bounds.spanMinutes), lt: slot.endsAt },
          },
          select: { id: true, startsAt: true, endsAt: true },
        });
        const ownConflict = ownConflicts.find((item) => item.endsAt > slot.startsAt);
        if (ownConflict) {
          return {
            won: false,
            reason: "CUSTOMER_DOUBLE_BOOKED" as const,
            appointmentId: ownConflict.id,
          };
        }

        const appointment = await tx.appointment.create({
          data: {
            customerId: entry.customerId,
            serviceId: entry.serviceId,
            staffId: slot.staffId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            locale: entry.locale,
            sourceChannel: entry.channel,
            statusHistory: { create: { status: "pending", reason: "waitlist offer claimed" } },
          },
        });
        const updated = await tx.waitlist.update({
          where: { id: entryId },
          data: { status: "converted", convertedAppointmentId: appointment.id },
        });
        return { won: true as const, entry: updated, appointment };
      }, SERIALIZABLE_TX_OPTIONS),
    );

    if (result.won) {
      return { won: true, entry: result.entry, appointment: result.appointment, alreadyClaimed: false };
    }

    // They answered and lost. Clearing notifiedAt puts them back at the head of the queue
    // with no cooldown, because the cooldown exists to punish silence, not bad luck.
    if (result.reason === "SLOT_TAKEN") {
      await prisma.waitlist.update({
        where: { id: entryId },
        data: { status: "active", notifiedAt: null },
      });
    }
    return {
      won: false,
      reason: result.reason,
      ...(result.appointmentId ? { conflictingAppointmentId: result.appointmentId } : {}),
    };
  }

  /**
   * W4 — record that an entry was satisfied by an appointment created somewhere else: the
   * desk booking the customer in by phone, or the customer walking through the normal web
   * flow after reading the offer. Idempotent for the same appointment.
   */
  async convert(entryId: string, appointmentId: string): Promise<Waitlist> {
    const [entry, appointment] = await Promise.all([
      prisma.waitlist.findUnique({ where: { id: entryId } }),
      prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: { id: true, customerId: true, serviceId: true, status: true },
      }),
    ]);
    if (!entry) throw new WaitlistError("ENTRY_NOT_FOUND");
    if (!appointment) throw new WaitlistError("APPOINTMENT_NOT_FOUND");
    if (entry.status === "cancelled") throw new WaitlistError("ENTRY_CANCELLED");
    if (entry.status === "converted") {
      if (entry.convertedAppointmentId === appointmentId) return entry;
      throw new WaitlistError("ALREADY_CONVERTED", entry.convertedAppointmentId ?? "unknown");
    }
    if (appointment.status === "cancelled") throw new WaitlistError("APPOINTMENT_CANCELLED");
    if (appointment.customerId !== entry.customerId) {
      throw new WaitlistError("APPOINTMENT_CUSTOMER_MISMATCH");
    }
    if (appointment.serviceId !== entry.serviceId) {
      throw new WaitlistError("APPOINTMENT_SERVICE_MISMATCH");
    }

    return prisma.waitlist.update({
      where: { id: entryId },
      data: { status: "converted", convertedAppointmentId: appointmentId },
    });
  }

  /**
   * W5 — housekeeping, safe to call from the cron endpoint on any schedule.
   *
   * Three independent sweeps, in this order:
   *  1. offers nobody answered go back to `active` while the window is still open. The
   *     `notifiedAt` timestamp is kept on purpose — it is what the cooldown reads.
   *  2. entries whose window has passed become `expired`.
   *  3. entries belonging to a customer erased under GDPR become `cancelled`, so the
   *     erasure does not leave a row that would try to text a deleted person.
   *
   * The lapse cutoff uses the unclamped TTL. `offerExpiresAt` may clamp an individual
   * offer to an earlier slot start, so `claim` can consider an offer dead slightly before
   * this sweep releases it; that direction is safe, the reverse would not be.
   */
  async expire(now = new Date()): Promise<WaitlistExpireResult> {
    const lapsedBefore = new Date(now.getTime() - offerTtlMinutes() * MS_PER_MINUTE);

    const released = await prisma.waitlist.updateMany({
      where: { status: "notified", notifiedAt: { lt: lapsedBefore }, latestAt: { gt: now } },
      data: { status: "active" },
    });
    const expired = await prisma.waitlist.updateMany({
      where: { status: { in: ["active", "notified"] }, latestAt: { lte: now } },
      data: { status: "expired" },
    });
    const erased = await prisma.waitlist.updateMany({
      where: {
        status: { in: ["active", "notified"] },
        customer: { OR: [{ deletedAt: { not: null } }, { anonymizedAt: { not: null } }] },
      },
      data: { status: "cancelled" },
    });

    return {
      releasedOffers: released.count,
      expiredWindows: expired.count,
      cancelledForErasedCustomers: erased.count,
    };
  }
}
