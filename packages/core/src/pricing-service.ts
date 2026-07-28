import { z } from "zod";
import { calculateDeposit, calculateTotalPrice } from "./index";
import { salonRepository } from "./repositories";

const pricingRequestSchema = z.object({
  serviceSlug: z.string().min(1),
  depositPercentage: z.number().min(0).max(100).default(30),
});

export class PricingService {
  async getPricing(rawInput: unknown) {
    const input = pricingRequestSchema.parse(rawInput);
    const service = await salonRepository.findServiceBySlug(input.serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");
    const total = calculateTotalPrice(service.priceCents);
    const deposit = calculateDeposit(total, input.depositPercentage);
    return {
      serviceSlug: service.slug,
      total,
      deposit,
      fullPayment: total,
    };
  }
}
