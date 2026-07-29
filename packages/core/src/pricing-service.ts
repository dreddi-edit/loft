import { z } from "zod";
import { calculateDeposit, calculateTotalPrice, type Money } from "./index";
import { salonRepository } from "./repositories";

export const DEPOSIT_THRESHOLD_CENTS = 5_000;
export const DEPOSIT_PERCENTAGE = 30;
export const DEPOSIT_THRESHOLD_ENV_VAR = "PAYMENTS_DEPOSIT_THRESHOLD_CENTS";
export const DEPOSIT_PERCENTAGE_ENV_VAR = "PAYMENTS_DEPOSIT_PERCENTAGE";

const MAX_THRESHOLD_CENTS = 1_000_000;

export type DepositPolicy = {
  depositRequired: boolean;
  deposit: Money;
  percentage: number;
  thresholdCents: number;
};

export type PricingResult = {
  serviceSlug: string;
  total: Money;
  deposit: Money;
  fullPayment: Money;
  depositRequired: boolean;
  depositPercentage: number;
  depositThresholdCents: number;
};

const warned = new Set<string>();

export function resetPricingWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(JSON.stringify({ severity: "WARNING", message, component: "pricing" }));
}

function readBoundedInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    warnOnce(name, `${name}="${raw}" is not an integer in [0, ${max}]; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function depositThresholdCents(): number {
  return readBoundedInt(DEPOSIT_THRESHOLD_ENV_VAR, DEPOSIT_THRESHOLD_CENTS, MAX_THRESHOLD_CENTS);
}

export function depositPercentage(): number {
  return readBoundedInt(DEPOSIT_PERCENTAGE_ENV_VAR, DEPOSIT_PERCENTAGE, 100);
}

/**
 * The only place that decides whether money is taken up front, and how much.
 *
 * A deposit is required strictly ABOVE the threshold, so a service priced exactly at the
 * threshold is booked without one. Nothing here reads request input: the previous
 * `depositPercentage` request field let a client post `0` and hold an expensive slot for
 * a zero-cent "deposit".
 */
export function resolveDepositPolicy(total: Money): DepositPolicy {
  const thresholdCents = depositThresholdCents();
  const percentage = depositPercentage();
  const aboveThreshold = total.amountCents > thresholdCents;
  const deposit = aboveThreshold
    ? calculateDeposit(total, percentage)
    : { amountCents: 0, currency: total.currency };

  return {
    depositRequired: aboveThreshold && deposit.amountCents > 0,
    deposit,
    percentage,
    thresholdCents,
  };
}

export function buildPricing(serviceSlug: string, basePriceCents: number): PricingResult {
  const total = calculateTotalPrice(basePriceCents);
  const policy = resolveDepositPolicy(total);
  return {
    serviceSlug,
    total,
    deposit: policy.deposit,
    fullPayment: total,
    depositRequired: policy.depositRequired,
    depositPercentage: policy.percentage,
    depositThresholdCents: policy.thresholdCents,
  };
}

// Unknown keys are stripped instead of rejected: callers still send the `depositPercentage`
// that the server now decides on its own, and a stale caller must not break pricing lookups.
const pricingRequestSchema = z.object({
  serviceSlug: z.string().trim().min(1),
});

export class PricingService {
  async getPricing(rawInput: unknown): Promise<PricingResult> {
    const input = pricingRequestSchema.parse(rawInput);
    const service = await salonRepository.findServiceBySlug(input.serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");
    return buildPricing(service.slug, service.priceCents);
  }
}
