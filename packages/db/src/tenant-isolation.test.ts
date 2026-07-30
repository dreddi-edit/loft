import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  currentTenantId,
  runWithTenantAsync,
} from "./tenant-context";

const OTHER_TENANT_ID = "cltenant00000000000000002";
const OTHER_TENANT_SLUG = "isolation-salon";
const PREFIX = `iso-${Date.now()}-`;

async function dbAvailable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)("tenant data isolation", () => {
  beforeAll(async () => {
    await prisma.tenant.upsert({
      where: { id: DEFAULT_TENANT_ID },
      update: { status: "active", slug: DEFAULT_TENANT_SLUG },
      create: {
        id: DEFAULT_TENANT_ID,
        slug: DEFAULT_TENANT_SLUG,
        displayName: "Hair Simo",
        status: "active",
        timeZone: "Europe/Rome",
        defaultLocale: "it",
        currency: "EUR",
      },
    });
    await prisma.tenant.upsert({
      where: { id: OTHER_TENANT_ID },
      update: { status: "active", slug: OTHER_TENANT_SLUG },
      create: {
        id: OTHER_TENANT_ID,
        slug: OTHER_TENANT_SLUG,
        displayName: "Isolation Salon",
        status: "active",
        timeZone: "Europe/Rome",
        defaultLocale: "de",
        currency: "EUR",
      },
    });

    await prisma.customer.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: `${PREFIX}a@example.com`,
        firstName: "Alpha",
        lastName: "Default",
      },
    });
    await prisma.customer.create({
      data: {
        tenantId: OTHER_TENANT_ID,
        email: `${PREFIX}b@example.com`,
        firstName: "Beta",
        lastName: "Other",
      },
    });
  });

  afterAll(async () => {
    for (const ctx of [
      { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG },
      { tenantId: OTHER_TENANT_ID, slug: OTHER_TENANT_SLUG },
    ]) {
      await runWithTenantAsync(ctx, async () => {
        await prisma.customer.deleteMany({ where: { email: { startsWith: PREFIX } } });
      });
    }
    await prisma.tenant.deleteMany({ where: { id: OTHER_TENANT_ID } }).catch(() => undefined);
  });

  it("findMany under tenant A never returns tenant B rows", async () => {
    await runWithTenantAsync(
      { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG },
      async () => {
        expect(currentTenantId()).toBe(DEFAULT_TENANT_ID);
        const rows = await prisma.customer.findMany({
          where: { email: { startsWith: PREFIX } },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tenantId).toBe(DEFAULT_TENANT_ID);
        expect(rows[0]?.email).toBe(`${PREFIX}a@example.com`);
      },
    );

    await runWithTenantAsync(
      { tenantId: OTHER_TENANT_ID, slug: OTHER_TENANT_SLUG },
      async () => {
        const rows = await prisma.customer.findMany({
          where: { email: { startsWith: PREFIX } },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tenantId).toBe(OTHER_TENANT_ID);
      },
    );
  });

  it("composite email unique is per tenant", async () => {
    const shared = `${PREFIX}shared@example.com`;
    await prisma.customer.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: shared,
        firstName: "Shared",
        lastName: "One",
      },
    });
    await prisma.customer.create({
      data: {
        tenantId: OTHER_TENANT_ID,
        email: shared,
        firstName: "Shared",
        lastName: "Two",
      },
    });

    await expect(
      prisma.customer.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email: shared,
          firstName: "Dup",
          lastName: "Same",
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
