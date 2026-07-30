import { z } from "zod";
import { calculateTotalPrice, type Money } from "./index";
import {
  DEPOSIT_THRESHOLD_CENTS,
  evaluateNoShowPolicy,
} from "./no-show-policy";
import { salonRepository } from "./repositories";

export { DEPOSIT_PERCENTAGE, DEPOSIT_THRESHOLD_CENTS } from "./no-show-policy";

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

export function resolveDepositPolicy(total: Money): DepositPolicy {
  const decision = evaluateNoShowPolicy({ servicePriceCents: total.amountCents });
  return {
    depositRequired: decision.depositRequired,
    deposit: { amountCents: decision.depositCents, currency: total.currency },
    percentage: decision.depositPercentage,
    thresholdCents: DEPOSIT_THRESHOLD_CENTS,
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
