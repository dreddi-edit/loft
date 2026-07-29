import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEPOSIT_PERCENTAGE,
  DEPOSIT_THRESHOLD_CENTS,
  NO_SHOW_FEE_PERCENTAGE,
  NO_SHOW_GRACE_MINUTES,
  describeNoShowPolicy,
  evaluateNoShowPolicy,
  isNoShowMarkable,
  noShowPolicyAppointmentFields,
} from "./no-show-policy";

const originalEnv = { ...process.env };

async function importWithEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  return import("./no-show-policy");
}

describe("no-show policy defaults", () => {
  it("uses the owner's numbers when nothing is configured", () => {
    expect(DEPOSIT_THRESHOLD_CENTS).toBe(5_000);
    expect(DEPOSIT_PERCENTAGE).toBe(30);
    expect(NO_SHOW_FEE_PERCENTAGE).toBe(30);
    expect(NO_SHOW_GRACE_MINUTES).toBe(15);
  });
});

describe("deposit threshold", () => {
  it("takes no deposit one cent below the threshold and verifies instead", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 4_999 });
    expect(decision).toEqual({
      depositRequired: false,
      depositCents: 0,
      depositPercentage: 0,
      verificationRequired: true,
      noShowFeeCents: 0,
      reason: "verification_required_below_threshold",
    });
  });

  it("requires a deposit exactly at the threshold", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 5_000 });
    expect(decision).toEqual({
      depositRequired: true,
      depositCents: 1_500,
      depositPercentage: 30,
      verificationRequired: false,
      noShowFeeCents: 1_500,
      reason: "deposit_required_above_threshold",
    });
  });

  it("requires a deposit above the threshold", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 12_000 });
    expect(decision.depositRequired).toBe(true);
    expect(decision.depositCents).toBe(3_600);
    expect(decision.noShowFeeCents).toBe(3_600);
    expect(decision.verificationRequired).toBe(false);
  });

  it("protects a free service by verification rather than by nothing", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 0 });
    expect(decision.depositRequired).toBe(false);
    expect(decision.verificationRequired).toBe(true);
  });
});

describe("verification exemptions", () => {
  it("skips the e-mail link on channels that already prove contact", () => {
    for (const sourceChannel of ["whatsapp", "sms", "voice"] as const) {
      const decision = evaluateNoShowPolicy({ servicePriceCents: 3_000, sourceChannel });
      expect(decision.verificationRequired).toBe(false);
      expect(decision.reason).toBe("verification_covered_by_channel");
    }
  });

  it("skips the e-mail link for an address that was already proved", () => {
    const decision = evaluateNoShowPolicy({
      servicePriceCents: 3_000,
      customerEmailVerified: true,
    });
    expect(decision.verificationRequired).toBe(false);
    expect(decision.reason).toBe("verification_covered_by_customer");
  });

  it("never lets an exemption remove a deposit", () => {
    const decision = evaluateNoShowPolicy({
      servicePriceCents: 9_000,
      sourceChannel: "whatsapp",
      customerEmailVerified: true,
    });
    expect(decision.depositRequired).toBe(true);
    expect(decision.depositCents).toBe(2_700);
  });
});

describe("client-supplied input", () => {
  it("rejects an unknown field instead of letting it through", () => {
    expect(() =>
      evaluateNoShowPolicy({
        servicePriceCents: 9_000,
        depositPercentage: 0,
      } as unknown as { servicePriceCents: number }),
    ).toThrow();
  });

  it("rejects a negative or fractional price", () => {
    expect(() => evaluateNoShowPolicy({ servicePriceCents: -1 })).toThrow();
    expect(() => evaluateNoShowPolicy({ servicePriceCents: 12.5 })).toThrow();
  });
});

describe("environment overrides", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("moves the threshold", async () => {
    const policy = await importWithEnv({ NO_SHOW_DEPOSIT_THRESHOLD_CENTS: "8000" });
    expect(policy.DEPOSIT_THRESHOLD_CENTS).toBe(8_000);
    expect(policy.evaluateNoShowPolicy({ servicePriceCents: 7_999 }).depositRequired).toBe(false);
    expect(policy.evaluateNoShowPolicy({ servicePriceCents: 8_000 }).depositRequired).toBe(true);
  });

  it("moves the deposit percentage", async () => {
    const policy = await importWithEnv({ NO_SHOW_DEPOSIT_PERCENTAGE: "50" });
    const decision = policy.evaluateNoShowPolicy({ servicePriceCents: 10_000 });
    expect(decision.depositCents).toBe(5_000);
    expect(decision.depositPercentage).toBe(50);
  });

  it("caps the no-show fee at the deposit the salon actually holds", async () => {
    const policy = await importWithEnv({
      NO_SHOW_DEPOSIT_PERCENTAGE: "30",
      NO_SHOW_FEE_PERCENTAGE: "80",
    });
    const decision = policy.evaluateNoShowPolicy({ servicePriceCents: 10_000 });
    expect(decision.depositCents).toBe(3_000);
    expect(decision.noShowFeeCents).toBe(3_000);
  });

  it("allows a partial forfeit below the deposit", async () => {
    const policy = await importWithEnv({ NO_SHOW_FEE_PERCENTAGE: "15" });
    const decision = policy.evaluateNoShowPolicy({ servicePriceCents: 10_000 });
    expect(decision.depositCents).toBe(3_000);
    expect(decision.noShowFeeCents).toBe(1_500);
  });

  it("fails at load on a value that is not a whole number in range", async () => {
    await expect(importWithEnv({ NO_SHOW_DEPOSIT_PERCENTAGE: "130" })).rejects.toThrow(
      /NO_SHOW_DEPOSIT_PERCENTAGE/,
    );
    process.env = { ...originalEnv };
    await expect(importWithEnv({ NO_SHOW_FEE_PERCENTAGE: "half" })).rejects.toThrow(
      /NO_SHOW_FEE_PERCENTAGE/,
    );
  });
});

describe("persisted appointment fields", () => {
  it("hands over exactly the two columns the decision owns", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 12_000 });
    expect(noShowPolicyAppointmentFields(decision)).toEqual({
      depositRequired: true,
      noShowFeeCents: 3_600,
    });
  });

  it("writes a zero fee for a booking with no deposit behind it", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 3_000 });
    expect(noShowPolicyAppointmentFields(decision)).toEqual({
      depositRequired: false,
      noShowFeeCents: 0,
    });
  });
});

describe("marking a no-show", () => {
  const startsAt = new Date("2026-08-04T08:00:00.000Z");

  it("waits out the courtesy window", () => {
    expect(isNoShowMarkable({ startsAt, status: "confirmed" }, startsAt)).toBe(false);
    expect(
      isNoShowMarkable({ startsAt, status: "confirmed" }, new Date("2026-08-04T08:14:59.000Z")),
    ).toBe(false);
    expect(
      isNoShowMarkable({ startsAt, status: "confirmed" }, new Date("2026-08-04T08:15:00.000Z")),
    ).toBe(true);
  });

  it("only applies to a booking that still expected the customer", () => {
    const later = new Date("2026-08-04T09:00:00.000Z");
    expect(isNoShowMarkable({ startsAt, status: "pending" }, later)).toBe(true);
    expect(isNoShowMarkable({ startsAt, status: "cancelled" }, later)).toBe(false);
    expect(isNoShowMarkable({ startsAt, status: "completed" }, later)).toBe(false);
    expect(isNoShowMarkable({ startsAt, status: "no_show" }, later)).toBe(false);
  });
});

describe("customer-facing description", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it("names the deposit in all four salon locales", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 12_000 });
    for (const locale of ["de", "it", "fr", "en"]) {
      const text = describeNoShowPolicy(decision, locale);
      expect(text).toContain("36");
      expect(text).toContain("30");
      expect(text.length).toBeGreaterThan(20);
    }
    expect(new Set(["de", "it", "fr", "en"].map((l) => describeNoShowPolicy(decision, l))).size).toBe(
      4,
    );
  });

  it("explains the e-mail link when no deposit is due", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 3_000 });
    expect(describeNoShowPolicy(decision, "de")).toMatch(/Link/);
    expect(describeNoShowPolicy(decision, "it")).toMatch(/link/);
  });

  it("falls back to the default locale for an unknown tag", () => {
    const decision = evaluateNoShowPolicy({ servicePriceCents: 3_000 });
    expect(describeNoShowPolicy(decision, "es")).toBe(describeNoShowPolicy(decision, "de"));
  });
});
