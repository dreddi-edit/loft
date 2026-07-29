import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@hair-simo/db", () => ({
  prisma: { service: { findUnique } },
}));

import {
  DEPOSIT_PERCENTAGE,
  DEPOSIT_THRESHOLD_CENTS,
  PricingService,
  buildPricing,
  resetPricingWarnings,
  resolveDepositPolicy,
} from "./pricing-service";

const EUR = "EUR" as const;

function money(amountCents: number) {
  return { amountCents, currency: EUR };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPricingWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deposit policy threshold", () => {
  it("takes no deposit below the threshold", () => {
    const policy = resolveDepositPolicy(money(DEPOSIT_THRESHOLD_CENTS - 1));
    expect(policy.depositRequired).toBe(false);
    expect(policy.deposit.amountCents).toBe(0);
  });

  it("takes no deposit exactly at the threshold", () => {
    const policy = resolveDepositPolicy(money(DEPOSIT_THRESHOLD_CENTS));
    expect(policy.depositRequired).toBe(false);
    expect(policy.deposit.amountCents).toBe(0);
  });

  it("takes a percentage deposit above the threshold", () => {
    const policy = resolveDepositPolicy(money(DEPOSIT_THRESHOLD_CENTS + 1));
    expect(policy.depositRequired).toBe(true);
    expect(policy.percentage).toBe(DEPOSIT_PERCENTAGE);
    expect(policy.deposit.amountCents).toBe(1_500);
  });

  it("reads the threshold and the percentage from the environment", () => {
    vi.stubEnv("PAYMENTS_DEPOSIT_THRESHOLD_CENTS", "10000");
    vi.stubEnv("PAYMENTS_DEPOSIT_PERCENTAGE", "50");

    expect(resolveDepositPolicy(money(9_000)).depositRequired).toBe(false);
    const policy = resolveDepositPolicy(money(20_000));
    expect(policy.thresholdCents).toBe(10_000);
    expect(policy.deposit.amountCents).toBe(10_000);
  });

  it("falls back to the defaults when the environment is not an integer", () => {
    vi.stubEnv("PAYMENTS_DEPOSIT_PERCENTAGE", "thirty");
    const policy = resolveDepositPolicy(money(10_000));
    expect(policy.percentage).toBe(DEPOSIT_PERCENTAGE);
    expect(policy.deposit.amountCents).toBe(3_000);
    expect(console.warn).toHaveBeenCalled();
  });

  it("reports no deposit when the configured percentage rounds to zero", () => {
    vi.stubEnv("PAYMENTS_DEPOSIT_PERCENTAGE", "0");
    const policy = resolveDepositPolicy(money(10_000));
    expect(policy.depositRequired).toBe(false);
    expect(policy.deposit.amountCents).toBe(0);
  });
});

describe("buildPricing", () => {
  it("keeps the full payment at the total and the deposit under it", () => {
    const pricing = buildPricing("balayage", 12_000);
    expect(pricing).toMatchObject({
      serviceSlug: "balayage",
      depositRequired: true,
      depositPercentage: DEPOSIT_PERCENTAGE,
      depositThresholdCents: DEPOSIT_THRESHOLD_CENTS,
    });
    expect(pricing.total.amountCents).toBe(12_000);
    expect(pricing.fullPayment.amountCents).toBe(12_000);
    expect(pricing.deposit.amountCents).toBe(3_600);
  });
});

describe("PricingService.getPricing", () => {
  it("ignores a deposit percentage sent by the caller", async () => {
    findUnique.mockResolvedValue({ slug: "colour", priceCents: 8_000, translations: [] });

    const zero = await new PricingService().getPricing({
      serviceSlug: "colour",
      depositPercentage: 0,
    });
    const oversized = await new PricingService().getPricing({
      serviceSlug: "colour",
      depositPercentage: 500,
    });
    const negative = await new PricingService().getPricing({
      serviceSlug: "colour",
      depositPercentage: -50,
    });

    expect(zero.deposit.amountCents).toBe(2_400);
    expect(oversized.deposit.amountCents).toBe(2_400);
    expect(negative.deposit.amountCents).toBe(2_400);
  });

  it("prices from the stored service and not from the request", async () => {
    findUnique.mockResolvedValue({ slug: "cut", priceCents: 3_500, translations: [] });
    const pricing = await new PricingService().getPricing({ serviceSlug: "cut" });
    expect(pricing.total.amountCents).toBe(3_500);
    expect(pricing.depositRequired).toBe(false);
    expect(pricing.deposit.amountCents).toBe(0);
  });

  it("rejects an unknown service", async () => {
    findUnique.mockResolvedValue(null);
    await expect(new PricingService().getPricing({ serviceSlug: "ghost" })).rejects.toThrow(
      "SERVICE_NOT_FOUND",
    );
  });

  it("rejects a missing service slug", async () => {
    await expect(new PricingService().getPricing({})).rejects.toThrow();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
