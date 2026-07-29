-- Multi-tenancy phase 3: composite uniques + denormalized tenantId on child tables.

-- Drop global uniques that become per-tenant.
DROP INDEX IF EXISTS "User_email_key";
DROP INDEX IF EXISTS "Customer_email_key";
DROP INDEX IF EXISTS "Customer_phone_key";
DROP INDEX IF EXISTS "Service_slug_key";
DROP INDEX IF EXISTS "Product_sku_key";
DROP INDEX IF EXISTS "Voucher_code_key";

CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");
CREATE UNIQUE INDEX "Customer_tenantId_email_key" ON "Customer"("tenantId", "email");
CREATE UNIQUE INDEX "Customer_tenantId_phone_key" ON "Customer"("tenantId", "phone");
CREATE UNIQUE INDEX "Service_tenantId_slug_key" ON "Service"("tenantId", "slug");
CREATE UNIQUE INDEX "Product_tenantId_sku_key" ON "Product"("tenantId", "sku");
CREATE UNIQUE INDEX "Voucher_tenantId_code_key" ON "Voucher"("tenantId", "code");
CREATE UNIQUE INDEX "BusinessHours_tenantId_dayOfWeek_key" ON "BusinessHours"("tenantId", "dayOfWeek");

-- Child tables: add tenantId, backfill from parent, FK + index.
ALTER TABLE "CustomerNote" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "CustomerNote" cn SET "tenantId" = c."tenantId" FROM "Customer" c WHERE cn."customerId" = c.id AND cn."tenantId" IS NULL;
UPDATE "CustomerNote" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "CustomerNote" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CustomerNote" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "ConsentRecord" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "ConsentRecord" cr SET "tenantId" = c."tenantId" FROM "Customer" c WHERE cr."customerId" = c.id AND cr."tenantId" IS NULL;
UPDATE "ConsentRecord" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "ConsentRecord" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ConsentRecord" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "ServiceTranslation" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "ServiceTranslation" st SET "tenantId" = s."tenantId" FROM "Service" s WHERE st."serviceId" = s.id AND st."tenantId" IS NULL;
UPDATE "ServiceTranslation" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "ServiceTranslation" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ServiceTranslation" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "StaffService" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "StaffService" ss SET "tenantId" = sp."tenantId" FROM "StaffProfile" sp WHERE ss."staffId" = sp.id AND ss."tenantId" IS NULL;
UPDATE "StaffService" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "StaffService" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "StaffService" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "StaffAvailabilityRule" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "StaffAvailabilityRule" sar SET "tenantId" = sp."tenantId" FROM "StaffProfile" sp WHERE sar."staffId" = sp.id AND sar."tenantId" IS NULL;
UPDATE "StaffAvailabilityRule" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "StaffAvailabilityRule" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "StaffAvailabilityRule" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "StaffTimeOff" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "StaffTimeOff" sto SET "tenantId" = sp."tenantId" FROM "StaffProfile" sp WHERE sto."staffId" = sp.id AND sto."tenantId" IS NULL;
UPDATE "StaffTimeOff" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "StaffTimeOff" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "StaffTimeOff" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "AppointmentStatusHistory" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "AppointmentStatusHistory" ash SET "tenantId" = a."tenantId" FROM "Appointment" a WHERE ash."appointmentId" = a.id AND ash."tenantId" IS NULL;
UPDATE "AppointmentStatusHistory" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "AppointmentStatusHistory" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AppointmentStatusHistory" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "Refund" r SET "tenantId" = p."tenantId" FROM "Payment" p WHERE r."paymentId" = p.id AND r."tenantId" IS NULL;
UPDATE "Refund" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "Refund" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Refund" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "BookingVerification" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "BookingVerification" bv SET "tenantId" = a."tenantId" FROM "Appointment" a WHERE bv."appointmentId" = a.id AND bv."tenantId" IS NULL;
UPDATE "BookingVerification" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "BookingVerification" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BookingVerification" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "ReviewRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "ReviewRequest" rr SET "tenantId" = a."tenantId" FROM "Appointment" a WHERE rr."appointmentId" = a.id AND rr."tenantId" IS NULL;
UPDATE "ReviewRequest" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "ReviewRequest" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ReviewRequest" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "VoucherRedemption" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "VoucherRedemption" vr SET "tenantId" = v."tenantId" FROM "Voucher" v WHERE vr."voucherId" = v.id AND vr."tenantId" IS NULL;
UPDATE "VoucherRedemption" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "VoucherRedemption" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "VoucherRedemption" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "Message" m SET "tenantId" = c."tenantId" FROM "Conversation" c WHERE m."conversationId" = c.id AND m."tenantId" IS NULL;
UPDATE "Message" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "Message" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Message" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

ALTER TABLE "InventoryMovement" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "InventoryMovement" im SET "tenantId" = p."tenantId" FROM "Product" p WHERE im."productId" = p.id AND im."tenantId" IS NULL;
UPDATE "InventoryMovement" SET "tenantId" = 'cltenant00000000000000001' WHERE "tenantId" IS NULL;
ALTER TABLE "InventoryMovement" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "InventoryMovement" ALTER COLUMN "tenantId" SET DEFAULT 'cltenant00000000000000001';

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'CustomerNote','ConsentRecord','ServiceTranslation','StaffService',
    'StaffAvailabilityRule','StaffTimeOff','AppointmentStatusHistory','Refund',
    'BookingVerification','ReviewRequest','VoucherRedemption','Message','InventoryMovement'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_tenantId_fkey');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE RESTRICT',
      t, t || '_tenantId_fkey'
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("tenantId")', t || '_tenantId_idx', t);
  END LOOP;
END $$;
