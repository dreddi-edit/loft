import { describe, expect, it } from "vitest";
import { inventoryAdjustmentSchema } from "./products/[id]/inventory/route";
import { reportQuerySchema } from "./reports/route";

describe("admin API mutation validation", () => {
  it("accepts traceable inventory adjustments", () => {
    expect(inventoryAdjustmentSchema.parse({
      quantity: -2,
      type: "sale",
      reason: "Retail sale",
    })).toEqual({
      quantity: -2,
      type: "sale",
      reason: "Retail sale",
    });
  });

  it("rejects zero-value and mass-assignment inventory changes", () => {
    expect(() => inventoryAdjustmentSchema.parse({
      quantity: 0,
      stock: 900,
      type: "adjustment",
    })).toThrow();
  });

  it("validates report ranges and export formats", () => {
    expect(reportQuerySchema.parse({
      from: "2026-07-01",
      to: "2026-07-31",
      format: "csv",
    })).toMatchObject({ format: "csv" });
    expect(() => reportQuerySchema.parse({
      from: "2026-08-01",
      to: "2026-07-01",
    })).toThrow();
  });
});
