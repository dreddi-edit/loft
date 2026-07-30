import { describe, expect, it } from "vitest";
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  currentTenantId,
  requireTenant,
  runWithTenant,
  runWithTenantAsync,
  scopeWhere,
} from "./tenant-context";

describe("tenant context", () => {
  it("falls back to the Hair Simo default outside a run", () => {
    expect(currentTenantId()).toBe(DEFAULT_TENANT_ID);
    expect(requireTenant().slug).toBe(DEFAULT_TENANT_SLUG);
  });

  it("scopes nested work to the active tenant", async () => {
    const other = { tenantId: "tenant_other", slug: "other-salon" };
    await runWithTenantAsync(other, async () => {
      expect(currentTenantId()).toBe("tenant_other");
      expect(scopeWhere({ active: true })).toEqual({ active: true, tenantId: "tenant_other" });
    });
    expect(currentTenantId()).toBe(DEFAULT_TENANT_ID);
  });

  it("isolates concurrent async contexts", async () => {
    const a = runWithTenantAsync({ tenantId: "a", slug: "a" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentTenantId();
    });
    const b = runWithTenantAsync({ tenantId: "b", slug: "b" }, async () => currentTenantId());
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
  });

  it("throws in multi mode when no context is set", () => {
    const previous = process.env.TENANT_MODE;
    process.env.TENANT_MODE = "multi";
    try {
      expect(() => requireTenant()).toThrow("TENANT_CONTEXT_MISSING");
    } finally {
      if (previous === undefined) delete process.env.TENANT_MODE;
      else process.env.TENANT_MODE = previous;
    }
  });

  it("runWithTenant is synchronous", () => {
    const value = runWithTenant({ tenantId: "sync", slug: "sync" }, () => currentTenantId());
    expect(value).toBe("sync");
  });
});
