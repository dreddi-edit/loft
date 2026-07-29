import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth-service";

describe("auth password helpers", () => {
  it("hashes and verifies password", async () => {
    const hash = await hashPassword("test-password-12");
    expect(hash).not.toBe("test-password-12");
    await expect(verifyPassword("test-password-12", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });
});
