import { z } from "zod";
import { getTenantContext } from "@hair-simo/db";
import { resolveLocale, type AppLocale } from "@hair-simo/i18n";
import type { AppointmentStatus, Channel } from "@hair-simo/db";

/**
 * The single authority on how a booking is protected against a no-show.
 *
 * The owner's decision, in one sentence: a deposit is taken only above a service-value
 * threshold, and every booking below that threshold is protected by a double opt-in
 * e-mail link instead. Expensive slots (balayage, treatments) are worth a payment step;
 * a men's cut is not, and asking for a card there would only push the customer to the
 * phone.
 *
 * Nothing in this module reads the request body. Every number below is resolved once from
 * the environment at module load and validated there, so a client cannot lower a deposit,
 * widen the threshold or zero a no-show fee by sending a field. Callers pass
 * `servicePriceCents` read from the Service row in the database, never a price supplied by
 * the browser.
 */

const DEFAULT_DEPOSIT_THRESHOLD_CENTS = 5_000;
const DEFAULT_DEPOSIT_PERCENTAGE = 30;
const DEFAULT_NO_SHOW_FEE_PERCENTAGE = 30;
const DEFAULT_NO_SHOW_GRACE_MINUTES = 15;

const MAX_SERVICE_PRICE_CENTS = 10_000_000;

const LOCALE_TAGS: Record<AppLocale, string> = {
  de: "de-IT",
  it: "it-IT",
  fr: "fr-FR",
  en: "en-GB",
};

function readIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid ${name} "${raw}". Expected a whole number between ${min} and ${max}.`,
    );
  }
  return parsed;
}

/**
 * Service value from which a deposit is due, in cents. Inclusive: a service priced at
 * exactly the threshold requires a deposit. "Deposits apply from EUR 50" is what the
 * salon can print on the booking page, and the inclusive reading is the one a customer
 * arrives at unaided.
 */
export const DEPOSIT_THRESHOLD_CENTS = readIntegerEnv(
  "NO_SHOW_DEPOSIT_THRESHOLD_CENTS",
  DEFAULT_DEPOSIT_THRESHOLD_CENTS,
  0,
  MAX_SERVICE_PRICE_CENTS,
);

/** Share of the service price taken up front when a deposit is due. */
export const DEPOSIT_PERCENTAGE = readIntegerEnv(
  "NO_SHOW_DEPOSIT_PERCENTAGE",
  DEFAULT_DEPOSIT_PERCENTAGE,
  0,
  100,
);

/**
 * Share of the service price the salon keeps when the customer does not turn up. It is
 * capped at the deposit actually collected, because the deposit is the only money the
 * salon holds — there is no card on file to charge afterwards. At the default of 30 it is
 * exactly the deposit, i.e. a full forfeit; lowering it to 15 means half the deposit is
 * refunded as a goodwill gesture.
 */
export const NO_SHOW_FEE_PERCENTAGE = readIntegerEnv(
  "NO_SHOW_FEE_PERCENTAGE",
  DEFAULT_NO_SHOW_FEE_PERCENTAGE,
  0,
  100,
);

/**
 * How long after the start time a booking may still be honoured before staff are allowed
 * to record it as a no-show. Fifteen minutes is the salon's own courtesy window; below
 * that a customer stuck at the traffic lights on Bahnhofstrasse would be billed.
 */
export const NO_SHOW_GRACE_MINUTES = readIntegerEnv(
  "NO_SHOW_GRACE_MINUTES",
  DEFAULT_NO_SHOW_GRACE_MINUTES,
  0,
  240,
);

export type NoShowPolicyReason =
  | "deposit_required_above_threshold"
  | "verification_required_below_threshold"
  | "verification_covered_by_channel"
  | "verification_covered_by_customer";

export type NoShowPolicyInput = {
  /** Server-side price of the booked service, in cents. Read it from the Service row. */
  servicePriceCents: number;
  /** How the booking arrived. Defaults to `web`. */
  sourceChannel?: Channel;
  /** True when this customer already proved control of their e-mail on an earlier booking. */
  customerEmailVerified?: boolean;
};

export type NoShowPolicyDecision = {
  depositRequired: boolean;
  depositCents: number;
  depositPercentage: number;
  verificationRequired: boolean;
  noShowFeeCents: number;
  reason: NoShowPolicyReason;
};

const policyInputSchema = z
  .object({
    servicePriceCents: z.number().int().min(0).max(MAX_SERVICE_PRICE_CENTS),
    sourceChannel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
    customerEmailVerified: z.boolean().default(false),
  })
  .strict();

/**
 * WhatsApp, SMS and voice bookings arrive from a phone number the carrier already proved
 * belongs to the sender, and there is no e-mail link to click in those flows. Only the
 * open web form can be filled with `nobody@example.com`.
 */
function channelProvesContact(channel: Channel): boolean {
  return channel !== "web";
}

function effectiveDepositThresholdCents(): number {
  const override = getTenantContext()?.settings?.noShowDepositThresholdCents;
  if (typeof override === "number" && Number.isInteger(override) && override >= 0) {
    return override;
  }
  return DEPOSIT_THRESHOLD_CENTS;
}

function effectiveDepositPercentage(): number {
  const override = getTenantContext()?.settings?.noShowDepositPercentage;
  if (typeof override === "number" && Number.isInteger(override) && override >= 0 && override <= 100) {
    return override;
  }
  return DEPOSIT_PERCENTAGE;
}

export function evaluateNoShowPolicy(input: NoShowPolicyInput): NoShowPolicyDecision {
  const parsed = policyInputSchema.parse(input);
  const price = parsed.servicePriceCents;
  const thresholdCents = effectiveDepositThresholdCents();
  const depositPercentage = effectiveDepositPercentage();

  const depositRequired = price >= thresholdCents;
  const depositCents = depositRequired ? Math.round((price * depositPercentage) / 100) : 0;
  const noShowFeeCents = Math.min(
    depositCents,
    Math.round((price * NO_SHOW_FEE_PERCENTAGE) / 100),
  );

  if (depositRequired) {
    return {
      depositRequired: true,
      depositCents,
      depositPercentage,
      verificationRequired: false,
      noShowFeeCents,
      reason: "deposit_required_above_threshold",
    };
  }

  const reason: NoShowPolicyReason = channelProvesContact(parsed.sourceChannel)
    ? "verification_covered_by_channel"
    : parsed.customerEmailVerified
      ? "verification_covered_by_customer"
      : "verification_required_below_threshold";

  return {
    depositRequired: false,
    depositCents: 0,
    depositPercentage: 0,
    verificationRequired: reason === "verification_required_below_threshold",
    noShowFeeCents: 0,
    reason,
  };
}

/**
 * The two Appointment columns the decision owns, ready to spread into a Prisma
 * `create`/`update`. Keeping them together stops a caller from persisting the deposit
 * flag while forgetting the fee.
 */
export function noShowPolicyAppointmentFields(decision: NoShowPolicyDecision): {
  depositRequired: boolean;
  noShowFeeCents: number;
} {
  return {
    depositRequired: decision.depositRequired,
    noShowFeeCents: decision.noShowFeeCents,
  };
}

/**
 * A booking may only be recorded as a no-show once it could actually have been honoured
 * and was not: after the start time plus the courtesy window, and only from a state that
 * still expected the customer to walk in.
 */
export function isNoShowMarkable(
  appointment: { startsAt: Date; status: AppointmentStatus },
  now: Date = new Date(),
): boolean {
  if (appointment.status !== "pending" && appointment.status !== "confirmed") return false;
  const startsAt = appointment.startsAt.getTime();
  if (!Number.isFinite(startsAt)) return false;
  return now.getTime() >= startsAt + NO_SHOW_GRACE_MINUTES * 60_000;
}

type PolicyCopy = {
  deposit: (deposit: string, percentage: number) => string;
  verification: string;
  none: string;
};

/**
 * Customer-facing explanation of the decision, in the four salon locales. It lives here
 * rather than in packages/i18n so the wording cannot drift away from the rule it
 * describes; a later phase moves the keys across.
 */
const POLICY_COPY: Record<AppLocale, PolicyCopy> = {
  de: {
    deposit: (deposit, percentage) =>
      `Für diese Leistung ist eine Anzahlung von ${deposit} (${percentage} %) fällig. ` +
      "Sie wird mit dem Endbetrag verrechnet und bei Nichterscheinen einbehalten.",
    verification:
      "Für diese Leistung wird keine Anzahlung fällig. Wir schicken Ihnen eine E-Mail: " +
      "Bitte bestätigen Sie den Termin über den Link darin, sonst geben wir den Platz wieder frei.",
    none: "Für diese Leistung wird keine Anzahlung fällig. Ihr Termin ist reserviert.",
  },
  it: {
    deposit: (deposit, percentage) =>
      `Per questo servizio è previsto un acconto di ${deposit} (${percentage} %). ` +
      "Viene detratto dall'importo finale e trattenuto in caso di mancata presentazione.",
    verification:
      "Per questo servizio non è previsto alcun acconto. Le inviamo un'e-mail: " +
      "confermi l'appuntamento tramite il link, altrimenti il posto verrà liberato.",
    none: "Per questo servizio non è previsto alcun acconto. Il suo appuntamento è confermato.",
  },
  fr: {
    deposit: (deposit, percentage) =>
      `Un acompte de ${deposit} (${percentage} %) est demandé pour cette prestation. ` +
      "Il est déduit du montant final et conservé en cas d'absence.",
    verification:
      "Aucun acompte n'est demandé pour cette prestation. Nous vous envoyons un e-mail : " +
      "merci de confirmer le rendez-vous via le lien, sans quoi le créneau sera libéré.",
    none: "Aucun acompte n'est demandé pour cette prestation. Votre rendez-vous est réservé.",
  },
  en: {
    deposit: (deposit, percentage) =>
      `This service requires a ${deposit} deposit (${percentage}%). ` +
      "It is deducted from the final amount and kept if you do not turn up.",
    verification:
      "No deposit is required for this service. We are sending you an e-mail: " +
      "please confirm the appointment via the link, otherwise we release the slot.",
    none: "No deposit is required for this service. Your appointment is reserved.",
  },
};

function formatEuro(cents: number, locale: AppLocale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

export function describeNoShowPolicy(decision: NoShowPolicyDecision, locale: string): string {
  const resolved = resolveLocale(locale);
  const copy = POLICY_COPY[resolved];
  if (decision.depositRequired) {
    return copy.deposit(formatEuro(decision.depositCents, resolved), decision.depositPercentage);
  }
  return decision.verificationRequired ? copy.verification : copy.none;
}
