-- Multi-tenancy phase 1–2: Tenant + tenantId on salon-owned roots, backfilled to Hair Simo Brixen.

CREATE TYPE "TenantStatus" AS ENUM ('provisioning', 'active', 'suspended');

CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "timeZone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "defaultLocale" TEXT NOT NULL DEFAULT 'it',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "webDomain" TEXT,
    "adminDomain" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

INSERT INTO "Tenant" ("id", "slug", "displayName", "legalName", "timeZone", "defaultLocale", "currency", "status", "settings", "createdAt", "updatedAt")
VALUES (
  'cltenant00000000000000001',
  'hairsimo-brixen',
  'Hair Simo',
  'Hair Simo',
  'Europe/Rome',
  'it',
  'EUR',
  'active',
  '{}',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

-- Helper macro pattern: add column with default so existing rows backfill, then FK + index.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "BusinessHours" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Voucher" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Waitlist" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "RecurringSeries" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "CallLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';
ALTER TABLE "DataRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'cltenant00000000000000001';

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User','StaffProfile','Customer','Service','BusinessHours','Product','Appointment',
    'Payment','Voucher','Waitlist','RecurringSeries','Conversation','CallLog',
    'NotificationLog','AuditLog','DataRequest'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_tenantId_fkey'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT',
      t, t || '_tenantId_fkey'
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("tenantId")', t || '_tenantId_idx', t);
  END LOOP;
END $$;
