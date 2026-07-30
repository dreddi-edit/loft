import { AsyncLocalStorage } from "node:async_hooks";

/** Fixed id for Hair Simo Brixen — used by migrations, seeds, and single-tenant mode. */
export const DEFAULT_TENANT_ID = "cltenant00000000000000001";
export const DEFAULT_TENANT_SLUG = "hairsimo-brixen";

export type TenantSettings = {
  noShowDepositThresholdCents?: number;
  noShowDepositPercentage?: number;
  branding?: { logoUrl?: string; primaryColor?: string };
};

export type TenantContext = {
  tenantId: string;
  slug: string;
  displayName?: string;
  timeZone?: string;
  defaultLocale?: string;
  settings?: TenantSettings;
};

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Active tenant for this async chain. Falls back to the default Hair Simo tenant so
 * single-salon local/dev keeps working without middleware.
 */
export function currentTenantId(): string {
  return tenantStorage.getStore()?.tenantId ?? DEFAULT_TENANT_ID;
}

export function requireTenant(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (ctx) return ctx;
  if (process.env.TENANT_MODE === "multi") {
    throw new Error("TENANT_CONTEXT_MISSING");
  }
  return {
    tenantId: DEFAULT_TENANT_ID,
    slug: DEFAULT_TENANT_SLUG,
    displayName: "Hair Simo",
    timeZone: "Europe/Rome",
    defaultLocale: "it",
  };
}

export function runWithTenant<T>(context: TenantContext, work: () => T): T {
  return tenantStorage.run(context, work);
}

export async function runWithTenantAsync<T>(
  context: TenantContext,
  work: () => Promise<T>,
): Promise<T> {
  return tenantStorage.run(context, work);
}

export function scopeWhere<T extends object>(where: T = {} as T): T & { tenantId: string } {
  return { ...where, tenantId: currentTenantId() };
}

export function withTenantCreate<T extends object>(data: T): T & { tenantId: string } {
  return { ...data, tenantId: currentTenantId() };
}

export function tenantEmailKey(email: string) {
  return { tenantId_email: { tenantId: currentTenantId(), email } };
}

export function tenantPhoneKey(phone: string) {
  return { tenantId_phone: { tenantId: currentTenantId(), phone } };
}

export function tenantSlugKey(slug: string) {
  return { tenantId_slug: { tenantId: currentTenantId(), slug } };
}

export function tenantSkuKey(sku: string) {
  return { tenantId_sku: { tenantId: currentTenantId(), sku } };
}

export function tenantCodeKey(code: string) {
  return { tenantId_code: { tenantId: currentTenantId(), code } };
}

export function tenantDayOfWeekKey(dayOfWeek: number) {
  return { tenantId_dayOfWeek: { tenantId: currentTenantId(), dayOfWeek } };
}

/**
 * Run `work` once for every active tenant. Cron jobs use this so a multi-salon
 * deployment does not silently process only the default tenant's rows.
 */
export async function forEachActiveTenant(
  work: (context: TenantContext) => Promise<void>,
): Promise<{ tenantCount: number }> {
  const { prisma } = await import("./client");
  const tenants = await prisma.tenant.findMany({
    where: { status: "active" },
    orderBy: { slug: "asc" },
  });
  for (const tenant of tenants) {
    const context: TenantContext = {
      tenantId: tenant.id,
      slug: tenant.slug,
      displayName: tenant.displayName,
      timeZone: tenant.timeZone,
      defaultLocale: tenant.defaultLocale,
      settings: (tenant.settings ?? {}) as TenantSettings,
    };
    await runWithTenantAsync(context, () => work(context));
  }
  return { tenantCount: tenants.length };
}

export const TENANT_SCOPED_MODELS = [
  "User",
  "StaffProfile",
  "Customer",
  "Service",
  "BusinessHours",
  "Product",
  "Appointment",
  "Payment",
  "Voucher",
  "Waitlist",
  "RecurringSeries",
  "Conversation",
  "CallLog",
  "NotificationLog",
  "AuditLog",
  "DataRequest",
  "CustomerNote",
  "ConsentRecord",
  "ServiceTranslation",
  "StaffService",
  "StaffAvailabilityRule",
  "StaffTimeOff",
  "AppointmentStatusHistory",
  "Refund",
  "BookingVerification",
  "ReviewRequest",
  "VoucherRedemption",
  "Message",
  "InventoryMovement",
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const TENANT_SCOPED = new Set<string>(TENANT_SCOPED_MODELS);

export function isTenantScopedModel(model: string | undefined): boolean {
  return typeof model === "string" && TENANT_SCOPED.has(model);
}
