import { describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG } from "@hair-simo/db";
import { resolveTenantContext, tenantContextFromSession } from "./tenant-resolve";

describe("resolveTenantContext", () => {
  it("uses the default salon when no header or subdomain is present", async () => {
    const ctx = await resolveTenantContext({ headerSlug: null, host: "localhost:3000" });
    expect(ctx).toMatchObject({
      tenantId: DEFAULT_TENANT_ID,
      slug: DEFAULT_TENANT_SLUG,
    });
  });

  it("prefers X-Tenant-Slug over host", async () => {
    const ctx = await resolveTenantContext({
      headerSlug: DEFAULT_TENANT_SLUG,
      host: "other.hairsimo.it",
    });
    expect(ctx.slug).toBe(DEFAULT_TENANT_SLUG);
  });

  it("maps session claims into a tenant context", () => {
    expect(
      tenantContextFromSession({
        tenantId: DEFAULT_TENANT_ID,
        tenantSlug: DEFAULT_TENANT_SLUG,
      }),
    ).toEqual({ tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG });
  });
});
