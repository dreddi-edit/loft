import { describe, expect, it } from "vitest";

import { calculateDeposit, calculateTotalPrice } from "./index";

describe("calculateDeposit", () => {
  it("caps values above 100 percent", () => {
    const result = calculateDeposit({ amountCents: 5000, currency: "EUR" }, 120);
    expect(result.amountCents).toBe(5000);
  });

  it("floors values below 0 percent", () => {
    const result = calculateDeposit({ amountCents: 5000, currency: "EUR" }, -30);
    expect(result.amountCents).toBe(0);
  });
});

describe("calculateTotalPrice", () => {
  it("adds addons onto base price", () => {
    const total = calculateTotalPrice(5000, [1000, 300]);
    expect(total.amountCents).toBe(6300);
  });
});
