import { describe, expect, it } from "vitest";
import { customerUpdateSchema } from "./route";

describe("customer update allowlist", () => {
  it("rejects mass-assignment fields", () => {
    expect(() =>
      customerUpdateSchema.parse({
        firstName: "Simo",
        sourceChannel: "voice",
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("accepts supported profile fields and a note", () => {
    expect(
      customerUpdateSchema.parse({
        email: "customer@example.com",
        marketingOptIn: true,
        note: "Prefers morning appointments",
      }),
    ).toEqual({
      email: "customer@example.com",
      marketingOptIn: true,
      note: "Prefers morning appointments",
    });
  });
});
