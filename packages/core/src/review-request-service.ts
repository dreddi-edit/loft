import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@hair-simo/db";
import { resolveLocale } from "@hair-simo/i18n";
import type { AppointmentStatus, Channel, NotificationStatus } from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";
import { NotificationService } from "./notification-service";
import type { DeliveryOutcome } from "./notification-service";
import { formatInSalonZone } from "./time";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export const REVIEW_TEMPLATE_KEY = "appointment.review.v1";
export const REVIEW_PLATFORM_GOOGLE = "google";

/**
 * Consent types that gate a review ask. `marketing` is the general opt-in written by the
 * booking form and by `GdprService`; `review` is the narrower opt-out a customer can give
 * for these asks alone. The newest record of EITHER saying no blocks the ask.
 */
export const REVIEW_CONSENT_TYPES = ["marketing", "review"] as const;

/**
 * Long enough that the customer has left the chair, looked in a mirror somewhere else
 * and formed an opinion; short enough that the visit is still the most recent thing
 * that happened to their hair. Asking at the till reads as pressure, asking a week
 * later reads as spam.
 */
export const DEFAULT_REVIEW_DELAY_HOURS = 3;

/** Past this the memory is stale and the ask is noise; the appointment is dropped. */
export const DEFAULT_REVIEW_MAX_AGE_DAYS = 14;

/** A regular customer visits every 6-8 weeks. Asking at most twice a year is polite. */
export const DEFAULT_REVIEW_COOLDOWN_DAYS = 180;

/**
 * Lifetime cap (R4). Someone who has ignored three asks over several years is telling
 * us something, and Google only counts one review per person anyway — every further
 * ask is pure cost with zero possible upside.
 */
export const DEFAULT_REVIEW_LIFETIME_CAP = 3;

/**
 * Someone who clicked through almost certainly left the review. Asking again inside two
 * years would be asking them to review the same salon twice.
 */
export const DEFAULT_REVIEWED_COOLDOWN_DAYS = 730;

/** A claimed-but-unsent request is retried, but not by two cron runs in the same hour. */
export const REVIEW_RETRY_AFTER_MINUTES = 60;

const TOKEN_SIGNATURE_LENGTH = 22;
const DEV_LINK_SECRET = "hair-simo-development-review-secret";

export type ReviewRequestPolicy = {
  delayHours: number;
  maxAgeDays: number;
  cooldownDays: number;
  lifetimeCap: number;
  reviewedCooldownDays: number;
  retryAfterMinutes: number;
};

export type ReviewSkipReason =
  | "APPOINTMENT_NOT_FOUND"
  | "NOT_COMPLETED"
  | "CUSTOMER_UNAVAILABLE"
  | "MARKETING_OPT_OUT"
  | "NO_CONTACT_DETAILS"
  | "ALREADY_REQUESTED"
  | "RETRY_TOO_SOON"
  | "TOO_SOON"
  | "TOO_LATE"
  | "COOLDOWN_ACTIVE"
  | "LIFETIME_CAP_REACHED"
  | "ALREADY_REVIEWED"
  | "REVIEW_LINK_NOT_CONFIGURED";

export type ReviewRequestOutcome =
  | {
      status: "sent" | "simulated" | "failed";
      appointmentId: string;
      requestId: string;
      url: string;
      delivery: DeliveryOutcome;
    }
  | { status: "skipped"; appointmentId: string; reason: ReviewSkipReason };

export type ReviewCustomer = {
  id: string;
  firstName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  marketingOptIn: boolean;
  deletedAt: Date | null;
  anonymizedAt: Date | null;
};

export type ReviewAppointmentInput = {
  id: string;
  status: AppointmentStatus;
  endsAt: Date;
  locale: string;
  customerId: string;
  customer?: ReviewCustomer;
};

export type ReviewDispatchEntry = {
  appointmentId: string;
  status: ReviewRequestOutcome["status"];
  reason?: string;
};

export type ReviewDispatchSummary = {
  processed: number;
  sent: number;
  simulated: number;
  failed: number;
  skipped: number;
  results: ReviewDispatchEntry[];
};

export type ReviewMetrics = {
  from: Date;
  to: Date;
  fromLabel: string;
  toLabel: string;
  created: number;
  sent: number;
  clicked: number;
  pending: number;
  clickRate: number;
  averageHoursToClick: number | null;
};

export type ReviewClickResult = {
  requestId: string;
  appointmentId: string;
  redirectUrl: string;
  firstClick: boolean;
};

type ReviewCopy = { subject: string; body: string };

/**
 * Kept here rather than in `packages/i18n` because a later phase consolidates the
 * dictionaries; the keys to move are listed in the handover. Register matches the
 * existing reminder templates: German formal, Italian informal, French formal.
 */
const REVIEW_COPY: Record<AppLocale, ReviewCopy> = {
  de: {
    subject: "Wie war Ihr Termin bei Hair Simo?",
    body:
      "Hallo {{name}}, vielen Dank für Ihren Besuch bei Hair Simo! Wenn Sie zufrieden waren, " +
      "freuen wir uns sehr über eine kurze Google-Bewertung – das dauert eine Minute: {{url}}",
  },
  it: {
    subject: "Com'è andato il tuo appuntamento da Hair Simo?",
    body:
      "Ciao {{name}}, grazie per la tua visita da Hair Simo! Se ti sei trovato bene, lasciaci " +
      "una breve recensione su Google: basta un minuto e per noi vale moltissimo: {{url}}",
  },
  fr: {
    subject: "Comment s'est passé votre rendez-vous chez Hair Simo ?",
    body:
      "Bonjour {{name}}, merci pour votre visite chez Hair Simo ! Si vous avez été satisfait(e), " +
      "laissez-nous un court avis Google : cela prend une minute et compte beaucoup pour nous : {{url}}",
  },
  en: {
    subject: "How was your appointment at Hair Simo?",
    body:
      "Hi {{name}}, thank you for visiting Hair Simo! If you were happy with your visit, a short " +
      "Google review takes about a minute and means a lot to us: {{url}}",
  },
};

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function reviewLinkSecret(): string {
  const secret =
    trimmedEnv("REVIEW_LINK_SECRET") ??
    trimmedEnv("APPOINTMENT_TOKEN_SECRET") ??
    trimmedEnv("JWT_SECRET");
  if (secret) return secret;
  if (isProduction()) throw new Error("REVIEW_LINK_SECRET_MISSING");
  return DEV_LINK_SECRET;
}

function baseUrl(): string {
  return (trimmedEnv("NEXT_PUBLIC_BASE_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
}

function sign(payload: string): string {
  return createHmac("sha256", reviewLinkSecret())
    .update(payload)
    .digest("base64url")
    .slice(0, TOKEN_SIGNATURE_LENGTH);
}

/**
 * Signed, stateless click token. The id alone would be enough to find the row, but a
 * bare cuid in a URL invites enumeration of every customer's review link; the HMAC
 * makes a guessed token useless without adding a column to `ReviewRequest`.
 */
export function createReviewToken(requestId: string): string {
  if (!requestId) throw new Error("REVIEW_REQUEST_ID_REQUIRED");
  const payload = Buffer.from(requestId, "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyReviewToken(token: string): string | null {
  if (typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(payload);
  const provided = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (provided.length !== wanted.length) return null;
  if (!timingSafeEqual(provided, wanted)) return null;
  const requestId = Buffer.from(payload, "base64url").toString("utf8");
  return requestId === "" ? null : requestId;
}

/**
 * The Google "write a review" deep link. `GOOGLE_REVIEW_URL` wins when the salon has a
 * short g.page link; otherwise it is built from the Maps place id.
 */
export function buildPlatformReviewUrl(locale: AppLocale): string | null {
  const override = trimmedEnv("GOOGLE_REVIEW_URL");
  if (override) return override;
  const placeId = trimmedEnv("GOOGLE_MAPS_PLACE_ID");
  if (!placeId) return null;
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}&hl=${locale}`;
}

/**
 * What actually goes into the message: our own hop, so a click can be attributed before
 * the customer lands on Google. Google gives us no callback, so this is the only signal
 * the salon will ever have about whether the ask worked.
 */
export function buildReviewUrl(requestId: string): string {
  return `${baseUrl()}/api/review/${createReviewToken(requestId)}`;
}

export function buildReviewMessage(input: {
  locale: AppLocale;
  firstName: string;
  url: string;
}): { subject: string; message: string } {
  const copy = REVIEW_COPY[input.locale] ?? REVIEW_COPY.de;
  const name = input.firstName.trim() === "" ? "" : input.firstName.trim();
  const message = copy.body
    .replace("{{name}}", name)
    .replace("{{url}}", input.url)
    .replace("  ", " ");
  return { subject: copy.subject, message };
}

/**
 * Email leaves over Gmail, which the `Channel` enum spells `web`; anything else falls
 * back to SMS on the phone number. Same rule as the reminder pipeline.
 */
function resolveTarget(customer: ReviewCustomer): { channel: Channel; recipient: string } | null {
  const email = customer.email?.trim();
  if (email) return { channel: "web", recipient: email };
  const phone = customer.phone?.trim();
  if (phone) return { channel: "sms", recipient: phone };
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "P2002";
}

function logStatus(outcome: DeliveryOutcome): NotificationStatus {
  if (outcome.status === "sent") return "sent";
  if (outcome.status === "scheduled") return "pending";
  if (outcome.status === "simulated") return "abandoned";
  return "failed";
}

function describeOutcome(outcome: DeliveryOutcome): string | null {
  if (outcome.status === "sent") return null;
  const reason = `${outcome.status.toUpperCase()}:${outcome.reason ?? "UNKNOWN"}`;
  return (outcome.detail ? `${reason} ${outcome.detail}` : reason).slice(0, 500);
}

function skip(appointmentId: string, reason: ReviewSkipReason): ReviewRequestOutcome {
  return { status: "skipped", appointmentId, reason };
}

export class ReviewRequestService {
  private readonly policy: ReviewRequestPolicy;
  private readonly notificationService: NotificationService;

  constructor(policy: Partial<ReviewRequestPolicy> = {}) {
    this.policy = {
      delayHours: policy.delayHours ?? DEFAULT_REVIEW_DELAY_HOURS,
      maxAgeDays: policy.maxAgeDays ?? DEFAULT_REVIEW_MAX_AGE_DAYS,
      cooldownDays: policy.cooldownDays ?? DEFAULT_REVIEW_COOLDOWN_DAYS,
      lifetimeCap: policy.lifetimeCap ?? DEFAULT_REVIEW_LIFETIME_CAP,
      reviewedCooldownDays: policy.reviewedCooldownDays ?? DEFAULT_REVIEWED_COOLDOWN_DAYS,
      retryAfterMinutes: policy.retryAfterMinutes ?? REVIEW_RETRY_AFTER_MINUTES,
    };
    this.notificationService = new NotificationService();
  }

  getPolicy(): ReviewRequestPolicy {
    return { ...this.policy };
  }

  /**
   * Marketing consent is the AND of the two records that can carry it: the current flag
   * on the customer and the newest `ConsentRecord` of each relevant type. Either one
   * saying no is a no — a stale `marketingOptIn` must never override a withdrawal, and
   * a withdrawal recorded only as a consent row must never be overridden by the flag.
   *
   * One indexed lookup per type rather than one capped read over both. A single
   * `findMany(take: n)` across both types silently drops the newest row of the quieter
   * type as soon as the other type has n newer rows, and the booking form writes a
   * marketing consent row on every booking — so a customer who withdrew review consent
   * once and then booked twenty times would have been asked again. `id` breaks ties on
   * `createdAt`, which is only millisecond-precise: a grant and a withdrawal recorded in
   * the same millisecond must not resolve in whichever order Postgres feels like.
   */
  private async hasMarketingConsent(customer: ReviewCustomer): Promise<boolean> {
    if (!customer.marketingOptIn) return false;
    const latest = await Promise.all(
      REVIEW_CONSENT_TYPES.map((type) =>
        prisma.consentRecord.findFirst({
          where: { customerId: customer.id, type },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { granted: true },
        }),
      ),
    );
    return latest.every((record) => record === null || record.granted);
  }

  /**
   * Frequency capping across the whole relationship, not just per appointment: how often
   * we have ever asked, when we last asked, and whether they ever clicked through.
   */
  private async loadAskHistory(customerId: string) {
    const rows = await prisma.reviewRequest.findMany({
      where: { appointment: { customerId }, sentAt: { not: null } },
      orderBy: { sentAt: "desc" },
      take: 50,
      select: { sentAt: true, clickedAt: true },
    });
    let lastSentAt: Date | null = null;
    let lastClickedAt: Date | null = null;
    for (const row of rows) {
      if (row.sentAt && (!lastSentAt || row.sentAt > lastSentAt)) lastSentAt = row.sentAt;
      if (row.clickedAt && (!lastClickedAt || row.clickedAt > lastClickedAt)) {
        lastClickedAt = row.clickedAt;
      }
    }
    return { sentCount: rows.length, lastSentAt, lastClickedAt };
  }

  private async loadAppointment(appointmentId: string): Promise<ReviewAppointmentInput | null> {
    const row = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        endsAt: true,
        locale: true,
        customerId: true,
        customer: {
          select: {
            id: true,
            firstName: true,
            email: true,
            phone: true,
            locale: true,
            marketingOptIn: true,
            deletedAt: true,
            anonymizedAt: true,
          },
        },
      },
    });
    if (!row) return null;
    return row as ReviewAppointmentInput;
  }

  /**
   * The whole eligibility chain for one appointment. Every rejection is a named skip
   * rather than an exception, because this runs in a batch where one ineligible
   * customer must never abort the other 259 of the month.
   */
  async scheduleForCompleted(
    appointment: string | ReviewAppointmentInput,
    options?: { now?: Date; platform?: string },
  ): Promise<ReviewRequestOutcome> {
    const now = options?.now ?? new Date();
    const platform = options?.platform ?? REVIEW_PLATFORM_GOOGLE;

    const loaded =
      typeof appointment === "string"
        ? await this.loadAppointment(appointment)
        : (appointment.customer ? appointment : await this.loadAppointment(appointment.id));
    const appointmentId = typeof appointment === "string" ? appointment : appointment.id;
    if (!loaded) return skip(appointmentId, "APPOINTMENT_NOT_FOUND");
    if (loaded.status !== "completed") return skip(loaded.id, "NOT_COMPLETED");

    const customer = loaded.customer;
    if (!customer || customer.deletedAt || customer.anonymizedAt) {
      return skip(loaded.id, "CUSTOMER_UNAVAILABLE");
    }

    const elapsedMs = now.getTime() - loaded.endsAt.getTime();
    if (elapsedMs < this.policy.delayHours * MS_PER_HOUR) return skip(loaded.id, "TOO_SOON");
    if (elapsedMs > this.policy.maxAgeDays * MS_PER_DAY) return skip(loaded.id, "TOO_LATE");

    const target = resolveTarget(customer);
    if (!target) return skip(loaded.id, "NO_CONTACT_DETAILS");
    if (!(await this.hasMarketingConsent(customer))) return skip(loaded.id, "MARKETING_OPT_OUT");

    const existing = await prisma.reviewRequest.findUnique({
      where: { appointmentId: loaded.id },
      select: { id: true, sentAt: true, updatedAt: true },
    });
    if (existing?.sentAt) return skip(loaded.id, "ALREADY_REQUESTED");
    if (
      existing &&
      now.getTime() - existing.updatedAt.getTime() < this.policy.retryAfterMinutes * 60_000
    ) {
      return skip(loaded.id, "RETRY_TOO_SOON");
    }

    const history = await this.loadAskHistory(customer.id);
    if (
      history.lastClickedAt &&
      now.getTime() - history.lastClickedAt.getTime() <
        this.policy.reviewedCooldownDays * MS_PER_DAY
    ) {
      return skip(loaded.id, "ALREADY_REVIEWED");
    }
    if (history.sentCount >= this.policy.lifetimeCap) {
      return skip(loaded.id, "LIFETIME_CAP_REACHED");
    }
    if (
      history.lastSentAt &&
      now.getTime() - history.lastSentAt.getTime() < this.policy.cooldownDays * MS_PER_DAY
    ) {
      return skip(loaded.id, "COOLDOWN_ACTIVE");
    }

    const locale = resolveLocale(loaded.locale ?? customer.locale);
    if (!buildPlatformReviewUrl(locale)) {
      console.warn("[review:not-configured]", { reason: "GOOGLE_MAPS_PLACE_ID_MISSING" });
      return skip(loaded.id, "REVIEW_LINK_NOT_CONFIGURED");
    }

    let requestId = existing?.id ?? null;
    if (!requestId) {
      try {
        const created = await prisma.reviewRequest.create({
          data: { appointmentId: loaded.id, platform },
          select: { id: true },
        });
        requestId = created.id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return skip(loaded.id, "ALREADY_REQUESTED");
      }
    }

    const url = buildReviewUrl(requestId);
    const { subject, message } = buildReviewMessage({
      locale,
      firstName: customer.firstName,
      url,
    });

    let delivery: DeliveryOutcome;
    try {
      delivery = await this.notificationService.send({
        channel: target.channel,
        recipient: target.recipient,
        subject,
        message,
        locale,
      });
    } catch (error) {
      delivery = {
        status: "failed",
        provider: "unknown",
        reason: "DELIVERY_ERROR",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const dispatched = delivery.status === "sent" || delivery.status === "simulated";
    await prisma.notificationLog.create({
      data: {
        appointmentId: loaded.id,
        channel: target.channel,
        recipient: target.recipient,
        templateKey: REVIEW_TEMPLATE_KEY,
        payload: { locale, subject, message, reviewRequestId: requestId },
        status: logStatus(delivery),
        attempts: 1,
        lastError: describeOutcome(delivery),
        sentAt: delivery.status === "sent" ? now : null,
      },
    });

    if (dispatched) {
      await prisma.reviewRequest.update({ where: { id: requestId }, data: { sentAt: now } });
    } else {
      await prisma.reviewRequest.update({ where: { id: requestId }, data: { platform } });
    }

    const status =
      delivery.status === "sent" ? "sent" : delivery.status === "simulated" ? "simulated" : "failed";

    return {
      status,
      appointmentId: loaded.id,
      requestId,
      url,
      delivery,
    };
  }

  /**
   * Batch entry point for the existing cron endpoint. Only appointments that finished
   * inside the ask window and have no sent request yet are loaded; every further rule
   * is enforced per appointment by {@link scheduleForCompleted}.
   */
  async dispatchDue(options?: {
    now?: Date;
    limit?: number;
    platform?: string;
  }): Promise<ReviewDispatchSummary> {
    const now = options?.now ?? new Date();
    const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
    const latestEnd = new Date(now.getTime() - this.policy.delayHours * MS_PER_HOUR);
    const earliestEnd = new Date(now.getTime() - this.policy.maxAgeDays * MS_PER_DAY);

    const rows = await prisma.appointment.findMany({
      where: {
        status: "completed",
        endsAt: { gte: earliestEnd, lte: latestEnd },
        OR: [{ reviewRequest: { is: null } }, { reviewRequest: { is: { sentAt: null } } }],
      },
      orderBy: { endsAt: "asc" },
      take: limit,
      select: {
        id: true,
        status: true,
        endsAt: true,
        locale: true,
        customerId: true,
        customer: {
          select: {
            id: true,
            firstName: true,
            email: true,
            phone: true,
            locale: true,
            marketingOptIn: true,
            deletedAt: true,
            anonymizedAt: true,
          },
        },
      },
    });

    const results: ReviewDispatchEntry[] = [];
    for (const row of rows as ReviewAppointmentInput[]) {
      const outcome = await this.scheduleForCompleted(row, {
        now,
        platform: options?.platform,
      });
      results.push({
        appointmentId: outcome.appointmentId,
        status: outcome.status,
        reason: outcome.status === "skipped" ? outcome.reason : outcome.delivery.reason,
      });
    }

    const counted = (status: ReviewDispatchEntry["status"]) =>
      results.filter((entry) => entry.status === status).length;

    return {
      processed: results.length,
      sent: counted("sent"),
      simulated: counted("simulated"),
      failed: counted("failed"),
      skipped: counted("skipped"),
      results,
    };
  }

  /**
   * Records the click exactly once. The conditional `updateMany` is what makes that
   * true under concurrency: two parallel opens of the same link both reach the database,
   * only the one that still sees `clickedAt IS NULL` updates a row.
   */
  async recordClick(token: string, options?: { now?: Date }): Promise<ReviewClickResult> {
    const now = options?.now ?? new Date();
    const requestId = verifyReviewToken(token);
    if (!requestId) throw new Error("INVALID_REVIEW_TOKEN");

    const request = await prisma.reviewRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        appointmentId: true,
        clickedAt: true,
        appointment: { select: { locale: true } },
      },
    });
    if (!request) throw new Error("REVIEW_REQUEST_NOT_FOUND");

    const claimed = await prisma.reviewRequest.updateMany({
      where: { id: requestId, clickedAt: null },
      data: { clickedAt: now },
    });

    const locale = resolveLocale(request.appointment?.locale ?? null);
    return {
      requestId: request.id,
      appointmentId: request.appointmentId,
      redirectUrl: buildPlatformReviewUrl(locale) ?? `${baseUrl()}/${locale}`,
      firstClick: claimed.count === 1,
    };
  }

  /**
   * What the salon owner actually wants to see: did the ask go out, did anyone act on
   * it. `clickRate` is clicks over sends, not over rows created, so requests that never
   * left the building cannot flatter or depress it.
   */
  async getMetrics(options?: {
    from?: Date;
    to?: Date;
    locale?: AppLocale;
  }): Promise<ReviewMetrics> {
    const to = options?.to ?? new Date();
    const from = options?.from ?? new Date(to.getTime() - 90 * MS_PER_DAY);
    const locale = options?.locale ?? "de";

    const rows = await prisma.reviewRequest.findMany({
      where: { createdAt: { gte: from, lt: to } },
      select: { createdAt: true, sentAt: true, clickedAt: true },
    });

    let sent = 0;
    let clicked = 0;
    let clickLatencyMs = 0;
    for (const row of rows) {
      if (row.sentAt) sent += 1;
      if (row.clickedAt) {
        clicked += 1;
        if (row.sentAt) clickLatencyMs += row.clickedAt.getTime() - row.sentAt.getTime();
      }
    }

    return {
      from,
      to,
      fromLabel: formatInSalonZone(from, locale, { dateStyle: "medium" }),
      toLabel: formatInSalonZone(to, locale, { dateStyle: "medium" }),
      created: rows.length,
      sent,
      clicked,
      pending: rows.length - sent,
      clickRate: sent === 0 ? 0 : Math.round((clicked / sent) * 10_000) / 10_000,
      averageHoursToClick:
        clicked === 0 ? null : Math.round((clickLatencyMs / clicked / MS_PER_HOUR) * 10) / 10,
    };
  }
}
