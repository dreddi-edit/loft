import { prisma, DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG, type TenantContext, type TenantSettings } from "@hair-simo/db";

/**
 * Resolves which salon this request belongs to.
 * Order: X-Tenant-Slug header → subdomain of Host → DEFAULT (Hair Simo Brixen).
 * Always loads the Tenant row so `settings` / timeZone stay authoritative.
 */
export async function resolveTenantContext(input: {
  headerSlug?: string | null;
  host?: string | null;
}): Promise<TenantContext> {
  const fromHeader = input.headerSlug?.trim().toLowerCase();
  const host = input.host?.split(":")[0]?.toLowerCase() ?? "";
  const subdomain = host.endsWith(".hairsimo.it")
    ? host.slice(0, -".hairsimo.it".length).replace(/\.admin$/, "").replace(/^admin\./, "")
    : host.endsWith(".localhost")
      ? host.slice(0, -".localhost".length)
      : "";

  const slug =
    fromHeader ||
    (subdomain && subdomain !== "www" && subdomain !== "admin" ? subdomain : "") ||
    DEFAULT_TENANT_SLUG;

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (tenant && tenant.status === "active") {
    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      displayName: tenant.displayName,
      timeZone: tenant.timeZone,
      defaultLocale: tenant.defaultLocale,
      settings: (tenant.settings ?? {}) as TenantSettings,
    };
  }

  if (slug === DEFAULT_TENANT_SLUG) {
    return {
      tenantId: DEFAULT_TENANT_ID,
      slug: DEFAULT_TENANT_SLUG,
      displayName: "Hair Simo",
      timeZone: "Europe/Rome",
      defaultLocale: "it",
    };
  }

  throw new Error("TENANT_NOT_FOUND");
}

export function tenantContextFromSession(session: {
  tenantId: string;
  tenantSlug: string;
}): TenantContext {
  return {
    tenantId: session.tenantId,
    slug: session.tenantSlug,
  };
}
