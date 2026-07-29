import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@hair-simo/db";
import { resolveLocale, type AppLocale } from "@hair-simo/i18n";
import { timingSafeStringEqual } from "./auth-service";
import { formatInSalonZone, formatSalonTimeRange } from "./time";

/**
 * Double opt-in for bookings that carry no deposit (see `no-show-policy.ts`). Without it
 * anyone can fill the salon's book with `nobody@example.com`: the appointment is created,
 * the slot is gone, and no message ever reaches a human. The link proves that whoever
 * typed the address can also read it.
 *
 * The token itself is never persisted. Only its SHA-256 digest goes into
 * `BookingVerification.tokenHash`, so a dump of that table cannot be replayed into
 * confirmed appointments.
 */

/** 32 bytes = 256 bits from the CSPRNG, base64url encoded to 43 URL-safe characters. */
export const VERIFICATION_TOKEN_BYTES = 32;

/** Hard cap on verification mails per appointment: one send plus two resends. */
export const MAX_VERIFICATION_SENDS = 3;

/** Minimum spacing between two sends, so the cap cannot be burned through in one second. */
export const VERIFICATION_RESEND_COOLDOWN_MS = 60_000;

/**
 * Widest window a customer gets to click. A booking taken at 23:00 has to survive until
 * the next morning's inbox, and a full day is what covers that without letting a slot rot
 * for a week.
 */
export const MAX_VERIFICATION_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A held slot is only worth reclaiming while it can still be resold. Two hours mirrors the
 * salon's own minimum booking lead time (`MIN_BOOKING_LEAD_MINUTES` in booking-service):
 * releasing later would hand back a slot nobody is allowed to take.
 */
export const PRE_APPOINTMENT_CUTOFF_MS = 120 * 60_000;

/**
 * Floor on the window. Below half an hour the link stops being a check and becomes a trap
 * — the customer who books a 15:00 slot at 12:30 would lose it while the mail is still in
 * the queue. Bookings that close cost the salon little to hold anyway.
 */
export const MIN_VERIFICATION_WINDOW_MS = 30 * 60_000;

/**
 * How many unconfirmed slots one customer may hold at once. Three is more than any real
 * person needs open at the same time and stops one address from parking a whole afternoon.
 */
export const MAX_CONCURRENT_UNVERIFIED_BOOKINGS = 3;

/** Grace before an appointment with no verification row at all counts as abandoned. */
export const ORPHAN_MIN_AGE_MS = 5 * 60_000;

export const SWEEP_BATCH_SIZE = 200;

/**
 * The one error an unknown, an expired and a superseded token all raise. Anything more
 * specific would turn the endpoint into an oracle for "does this booking exist".
 */
export const VERIFICATION_INVALID = "BOOKING_VERIFICATION_INVALID";

export const VERIFICATION_CANCELLED = "BOOKING_VERIFICATION_APPOINTMENT_CANCELLED";

export const UNVERIFIED_CANCELLATION_REASON = "verification expired";
export const VERIFIED_CONFIRMATION_REASON = "email verified";

const appointmentIdSchema = z.string().trim().min(1).max(64);
const tokenSchema = z.string().trim().min(16).max(512);

export function createVerificationToken(): string {
  return randomBytes(VERIFICATION_TOKEN_BYTES).toString("base64url");
}

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compared against when no row was found, so the caller pays the same comparison cost for
 * an unknown token as for a real one. Same idea as the dummy bcrypt hash in auth-service.
 */
const ABSENT_TOKEN_HASH = hashVerificationToken("booking-verification::absent");

/**
 * Deadline for one issued link. A fixed duration is wrong: 24 hours after issuing is past
 * the appointment itself when the customer books for tomorrow morning, and the sweeper
 * would then release a slot that has already been sat in. So the window is the shorter of
 * "a day from now" and "two hours before the chair is needed", with a floor so a
 * last-minute booking still gets a fair chance to click.
 */
export function verificationDeadline(now: Date, startsAt: Date): Date {
  const nowMs = now.getTime();
  const capped = Math.min(nowMs + MAX_VERIFICATION_WINDOW_MS, startsAt.getTime() - PRE_APPOINTMENT_CUTOFF_MS);
  return new Date(Math.max(nowMs + MIN_VERIFICATION_WINDOW_MS, capped));
}

export function verificationPath(token: string, locale: string): string {
  return `/${resolveLocale(locale)}/booking/verify/${encodeURIComponent(token)}`;
}

export type IssuedVerification = {
  appointmentId: string;
  token: string;
  expiresAt: Date;
  sentCount: number;
  locale: AppLocale;
  recipient: string;
  startsAt: Date;
  endsAt: Date;
};

export type VerificationResult = {
  appointmentId: string;
  alreadyVerified: boolean;
};

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

type ExistingVerification = { verifiedAt: Date | null; sentCount: number } | null;

function resendRejection(existing: ExistingVerification): Error {
  if (!existing) return new Error("VERIFICATION_ISSUE_CONFLICT");
  if (existing.verifiedAt) return new Error("VERIFICATION_ALREADY_VERIFIED");
  if (existing.sentCount >= MAX_VERIFICATION_SENDS) return new Error("VERIFICATION_RESEND_LIMIT");
  return new Error("VERIFICATION_RESEND_TOO_SOON");
}

/**
 * Slots this customer is holding without having proved the address. Counted over future
 * appointments only — a past unverified booking blocks nothing.
 */
export async function countUnverifiedBookings(
  customerId: string,
  opts: { now?: Date; excludeAppointmentId?: string } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  return prisma.appointment.count({
    where: {
      customerId,
      status: "pending",
      startsAt: { gt: now },
      verification: { is: { verifiedAt: null } },
      ...(opts.excludeAppointmentId ? { id: { not: opts.excludeAppointmentId } } : {}),
    },
  });
}

/**
 * Issue (or rotate) the double opt-in link for one appointment.
 *
 * There is at most one row per appointment — `appointmentId` is unique — so re-issuing
 * replaces the stored digest, which silently invalidates every earlier link. The cap and
 * the cooldown live inside the `WHERE` of the update rather than in a read-then-write, so
 * two parallel resend clicks cannot both pass the check: the row lock the conditional
 * UPDATE takes makes exactly one of them see `count === 1`.
 */
export async function issueVerification(
  rawAppointmentId: string,
  opts: { now?: Date; enforceCustomerCap?: boolean } = {},
): Promise<IssuedVerification> {
  const appointmentId = appointmentIdSchema.parse(rawAppointmentId);
  const now = opts.now ?? new Date();

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      locale: true,
      customerId: true,
      customer: { select: { email: true } },
    },
  });
  if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
  if (appointment.status !== "pending") throw new Error("APPOINTMENT_NOT_PENDING");

  const recipient = appointment.customer.email?.trim();
  if (!recipient) throw new Error("CUSTOMER_EMAIL_MISSING");

  if (opts.enforceCustomerCap !== false) {
    const held = await countUnverifiedBookings(appointment.customerId, {
      now,
      excludeAppointmentId: appointment.id,
    });
    if (held >= MAX_CONCURRENT_UNVERIFIED_BOOKINGS) throw new Error("UNVERIFIED_BOOKING_LIMIT");
  }

  const token = createVerificationToken();
  const tokenHash = hashVerificationToken(token);
  const expiresAt = verificationDeadline(now, appointment.startsAt);
  const base = {
    appointmentId,
    token,
    expiresAt,
    locale: resolveLocale(appointment.locale),
    recipient,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
  };

  const rotated = await prisma.bookingVerification.updateMany({
    where: {
      appointmentId,
      verifiedAt: null,
      sentCount: { lt: MAX_VERIFICATION_SENDS },
      updatedAt: { lte: new Date(now.getTime() - VERIFICATION_RESEND_COOLDOWN_MS) },
    },
    data: { tokenHash, expiresAt, sentCount: { increment: 1 } },
  });

  if (rotated.count > 0) {
    const row = await prisma.bookingVerification.findUnique({
      where: { appointmentId },
      select: { sentCount: true },
    });
    return { ...base, sentCount: row?.sentCount ?? MAX_VERIFICATION_SENDS };
  }

  try {
    const created = await prisma.bookingVerification.create({
      data: { appointmentId, tokenHash, expiresAt, sentCount: 1 },
    });
    return { ...base, sentCount: created.sentCount };
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    const existing = await prisma.bookingVerification.findUnique({
      where: { appointmentId },
      select: { verifiedAt: true, sentCount: true },
    });
    throw resendRejection(existing);
  }
}

/**
 * Redeem a link.
 *
 * Unknown, expired and rotated-away tokens are indistinguishable: all three raise
 * `BOOKING_VERIFICATION_INVALID`, and the digest comparison runs against a fixed dummy
 * when no row was found so the failure paths do the same work. The residual signal is the
 * index probe on `tokenHash`, and it carries nothing usable — unlike a password
 * comparison there is no prefix an attacker can extend, because the lookup key is a full
 * SHA-256 preimage they would have to guess in one go.
 *
 * A second click on the same, still-valid link returns `alreadyVerified: true` instead of
 * an error. Whoever presents the token already received the mail, so telling them the job
 * is done reveals nothing they do not know, and the alternative is a confirmed booking
 * behind an error page.
 *
 * Read Committed is deliberate. Mutual exclusion comes from the row lock the conditional
 * UPDATE takes and Postgres re-evaluating the `verifiedAt: null` predicate against the
 * locked row version, so exactly one of two concurrent clicks reports `count === 1`.
 * Serializable would add nothing here except 40001 aborts on the single most likely
 * concurrent event, a double-clicked link.
 */
export async function verifyBookingToken(
  rawToken: string,
  now: Date = new Date(),
): Promise<VerificationResult> {
  const parsed = tokenSchema.safeParse(rawToken);
  const tokenHash = hashVerificationToken(parsed.success ? parsed.data : "");

  const row = await prisma.bookingVerification.findUnique({
    where: { tokenHash },
    select: { id: true, appointmentId: true, tokenHash: true, expiresAt: true, verifiedAt: true },
  });
  const matched = timingSafeStringEqual(tokenHash, row?.tokenHash ?? ABSENT_TOKEN_HASH);
  if (!row || !matched) throw new Error(VERIFICATION_INVALID);

  if (row.verifiedAt) return { appointmentId: row.appointmentId, alreadyVerified: true };
  if (row.expiresAt.getTime() <= now.getTime()) throw new Error(VERIFICATION_INVALID);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.bookingVerification.updateMany({
      where: { id: row.id, verifiedAt: null },
      data: { verifiedAt: now },
    });
    if (claimed.count === 0) return { appointmentId: row.appointmentId, alreadyVerified: true };

    const appointment = await tx.appointment.findUnique({
      where: { id: row.appointmentId },
      select: { status: true },
    });
    if (!appointment) throw new Error(VERIFICATION_INVALID);
    if (appointment.status === "cancelled") throw new Error(VERIFICATION_CANCELLED);

    const confirmed = await tx.appointment.updateMany({
      where: { id: row.appointmentId, status: "pending" },
      data: { status: "confirmed" },
    });
    if (confirmed.count > 0) {
      await tx.appointmentStatusHistory.create({
        data: {
          appointmentId: row.appointmentId,
          status: "confirmed",
          reason: VERIFIED_CONFIRMATION_REASON,
        },
      });
    }
    return { appointmentId: row.appointmentId, alreadyVerified: false };
  });
}

/**
 * Cancel a pending appointment, once. The conditional UPDATE is the whole concurrency
 * story: a second cron run, or a customer cancelling at the same moment, sees `count === 0`
 * and neither writes a duplicate history row nor gets counted as a release.
 */
async function cancelPendingAppointment(appointmentId: string, reason: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const cancelled = await tx.appointment.updateMany({
      where: { id: appointmentId, status: "pending" },
      data: { status: "cancelled", cancellationReason: reason },
    });
    if (cancelled.count === 0) return false;
    await tx.appointmentStatusHistory.create({
      data: { appointmentId, status: "cancelled", reason },
    });
    return true;
  });
}

/**
 * Release the slots of every booking whose link was never clicked in time. The per-booking
 * grace period was already decided by `verificationDeadline` when the link was issued and
 * stored in `expiresAt`, so the sweeper stays a plain "deadline passed" query and a cron
 * run just passes `new Date()`.
 *
 * Returns how many slots this run actually released.
 */
export async function expireUnverifiedBefore(
  cutoff: Date = new Date(),
  opts: { limit?: number } = {},
): Promise<number> {
  const due = await prisma.bookingVerification.findMany({
    where: {
      verifiedAt: null,
      expiresAt: { lte: cutoff },
      appointment: { status: "pending" },
    },
    select: { appointmentId: true },
    orderBy: { expiresAt: "asc" },
    take: opts.limit ?? SWEEP_BATCH_SIZE,
  });

  let released = 0;
  for (const row of due) {
    if (await cancelPendingAppointment(row.appointmentId, UNVERIFIED_CANCELLATION_REASON)) {
      released += 1;
    }
  }
  return released;
}

/**
 * The other half of the sweep: web bookings that took the verification path but never got
 * a `BookingVerification` row at all, because issuing or sending failed after the
 * appointment was created. Without this they would hold a slot forever — `expiresAt` can
 * only expire a row that exists.
 *
 * `depositRequired: false` plus `sourceChannel: "web"` is exactly the set the policy sends
 * down the verification path, so phone and WhatsApp bookings, which never get a link, are
 * not touched. The minimum age keeps a booking created seconds ago safe while the caller
 * is still on its way to `issueVerification`.
 */
export async function releaseOrphanedUnverified(
  cutoff: Date = new Date(),
  opts: { limit?: number } = {},
): Promise<number> {
  const cutoffMs = cutoff.getTime();
  const orphans = await prisma.appointment.findMany({
    where: {
      status: "pending",
      depositRequired: false,
      sourceChannel: "web",
      verification: { is: null },
      createdAt: { lte: new Date(cutoffMs - ORPHAN_MIN_AGE_MS) },
      OR: [
        { createdAt: { lte: new Date(cutoffMs - MAX_VERIFICATION_WINDOW_MS) } },
        { startsAt: { lte: new Date(cutoffMs + PRE_APPOINTMENT_CUTOFF_MS) } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? SWEEP_BATCH_SIZE,
  });

  let released = 0;
  for (const orphan of orphans) {
    if (await cancelPendingAppointment(orphan.id, UNVERIFIED_CANCELLATION_REASON)) released += 1;
  }
  return released;
}

type VerificationCopy = {
  subject: string;
  body: (slot: string, deadline: string, url: string) => string;
};

/**
 * The mail body in the four salon locales. It sits here rather than in packages/i18n so
 * the wording cannot drift from the deadline logic above; a later phase moves the keys.
 */
const VERIFICATION_COPY: Record<AppLocale, VerificationCopy> = {
  de: {
    subject: "Bitte bestätigen Sie Ihren Termin bei Hair Simo",
    body: (slot, deadline, url) =>
      `Ihr Terminwunsch: ${slot}.\n\n` +
      `Bitte bestätigen Sie ihn über diesen Link: ${url}\n\n` +
      `Der Link ist bis ${deadline} gültig. Ohne Bestätigung geben wir den Termin wieder frei.`,
  },
  it: {
    subject: "Conferma il tuo appuntamento da Hair Simo",
    body: (slot, deadline, url) =>
      `Appuntamento richiesto: ${slot}.\n\n` +
      `Confermalo tramite questo link: ${url}\n\n` +
      `Il link è valido fino alle ${deadline}. Senza conferma libereremo il posto.`,
  },
  fr: {
    subject: "Merci de confirmer votre rendez-vous chez Hair Simo",
    body: (slot, deadline, url) =>
      `Rendez-vous demandé : ${slot}.\n\n` +
      `Merci de le confirmer via ce lien : ${url}\n\n` +
      `Le lien est valable jusqu'au ${deadline}. Sans confirmation, le créneau sera libéré.`,
  },
  en: {
    subject: "Please confirm your Hair Simo appointment",
    body: (slot, deadline, url) =>
      `Requested appointment: ${slot}.\n\n` +
      `Please confirm it using this link: ${url}\n\n` +
      `The link is valid until ${deadline}. Without confirmation we release the slot.`,
  },
};

export function buildVerificationEmail(input: {
  locale: string;
  verifyUrl: string;
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
}): { locale: AppLocale; subject: string; message: string } {
  const locale = resolveLocale(input.locale);
  const copy = VERIFICATION_COPY[locale];
  const slot = formatSalonTimeRange(input.startsAt, input.endsAt, locale);
  const deadline = formatInSalonZone(input.expiresAt, locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return { locale, subject: copy.subject, message: copy.body(slot, deadline, input.verifyUrl) };
}
