import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth-service";

describe("auth password helpers", () => {
  it("hashes and verifies password", async () => {
    const hash = await hashPassword("HairSimo2026!");
    expect(hash).not.toBe("HairSimo2026!");
    await expect(verifyPassword("HairSimo2026!", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });
});
