import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@hair-simo/db", () => ({

  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({ tenantId_email: { tenantId: "cltenant00000000000000001", email } }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({ tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek } }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },

  prisma: { service: { findUnique } },
}));

const originalEnv = { ...process.env };

async function importPricingWithEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  return import("./pricing-service");
}

import {
  DEPOSIT_PERCENTAGE,
  DEPOSIT_THRESHOLD_CENTS,
  PricingService,
  buildPricing,
  resolveDepositPolicy,
} from "./pricing-service";

const EUR = "EUR" as const;

function money(amountCents: number) {
  return { amountCents, currency: EUR };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("deposit policy threshold", () => {
  it("takes no deposit below the threshold", () => {
    const policy = resolveDepositPolicy(money(DEPOSIT_THRESHOLD_CENTS - 1));
    expect(policy.depositRequired).toBe(false);
    expect(policy.deposit.amountCents).toBe(0);
  });

  it("requires a deposit exactly at the threshold", () => {
    const policy = resolveDepositPolicy(money(DEPOSIT_THRESHOLD_CENTS));
    expect(policy.depositRequired).toBe(true);
    expect(policy.deposit.amountCents).toBe(1_500);
  });

  it("takes a percentage deposit above the threshold", () => {
    const policy = resolveDepositPolicy(money(DEPOSIT_THRESHOLD_CENTS + 1));
    expect(policy.depositRequired).toBe(true);
    expect(policy.percentage).toBe(DEPOSIT_PERCENTAGE);
    expect(policy.deposit.amountCents).toBe(1_500);
  });

  it("reads the threshold and the percentage from the environment", async () => {
    const pricing = await importPricingWithEnv({
      NO_SHOW_DEPOSIT_THRESHOLD_CENTS: "10000",
      NO_SHOW_DEPOSIT_PERCENTAGE: "50",
    });

    expect(pricing.resolveDepositPolicy(money(9_000)).depositRequired).toBe(false);
    const policy = pricing.resolveDepositPolicy(money(20_000));
    expect(policy.thresholdCents).toBe(10_000);
    expect(policy.deposit.amountCents).toBe(10_000);
  });

  it("keeps deposit required at zero percent but charges nothing", async () => {
    const pricing = await importPricingWithEnv({ NO_SHOW_DEPOSIT_PERCENTAGE: "0" });
    const policy = pricing.resolveDepositPolicy(money(10_000));
    expect(policy.depositRequired).toBe(true);
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
