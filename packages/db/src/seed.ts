import { PrismaClient, type RoleKey } from "@prisma/client";

const prisma = new PrismaClient();

const locales = ["de", "it", "fr", "en"] as const;

async function seedRoles() {
  const roleKeys: RoleKey[] = ["owner", "manager", "staff"];
  for (const key of roleKeys) {
    await prisma.role.upsert({
      where: { key },
      update: {},
      create: { key },
    });
  }
}

async function seedServices() {
  const baseServices = [
    {
      slug: "haircut-women",
      category: "cut",
      durationMin: 60,
      priceCents: 6500,
      translations: {
        de: { name: "Damenhaarschnitt", description: "Waschen, schneiden, föhnen." },
        it: { name: "Taglio donna", description: "Lavaggio, taglio e piega." },
        fr: { name: "Coupe femme", description: "Shampooing, coupe et brushing." },
        en: { name: "Women's haircut", description: "Wash, cut and blow-dry." },
      },
    },
    {
      slug: "color-root-touchup",
      category: "color",
      durationMin: 90,
      priceCents: 8900,
      translations: {
        de: { name: "Ansatzfarbe", description: "Färbung für den Ansatz." },
        it: { name: "Ritocco radice", description: "Colorazione ricrescita." },
        fr: { name: "Retouche racines", description: "Coloration des racines." },
        en: { name: "Root touch-up", description: "Hair root coloring service." },
      },
    },
  ];

  for (const service of baseServices) {
    const created = await prisma.service.upsert({
      where: { slug: service.slug },
      update: {
        category: service.category,
        durationMin: service.durationMin,
        priceCents: service.priceCents,
      },
      create: {
        slug: service.slug,
        category: service.category,
        durationMin: service.durationMin,
        priceCents: service.priceCents,
      },
    });

    for (const locale of locales) {
      const t = service.translations[locale];
      await prisma.serviceTranslation.upsert({
        where: { serviceId_locale: { serviceId: created.id, locale } },
        update: { name: t.name, description: t.description },
        create: { serviceId: created.id, locale, name: t.name, description: t.description },
      });
    }
  }
}

async function seedBusinessHours() {
  await prisma.businessHours.deleteMany();
  const ranges = [
    { dayOfWeek: 1, startMin: 9 * 60, endMin: 18 * 60, isOpen: true },
    { dayOfWeek: 2, startMin: 9 * 60, endMin: 18 * 60, isOpen: true },
    { dayOfWeek: 3, startMin: 9 * 60, endMin: 18 * 60, isOpen: true },
    { dayOfWeek: 4, startMin: 9 * 60, endMin: 20 * 60, isOpen: true },
    { dayOfWeek: 5, startMin: 9 * 60, endMin: 20 * 60, isOpen: true },
    { dayOfWeek: 6, startMin: 8 * 60, endMin: 16 * 60, isOpen: true },
    { dayOfWeek: 0, startMin: 0, endMin: 0, isOpen: false },
  ];
  await prisma.businessHours.createMany({ data: ranges });
}

async function seedStaffAndCustomer() {
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: "owner" } });
  const staffRole = await prisma.role.findUniqueOrThrow({ where: { key: "staff" } });

  const owner = await prisma.user.upsert({
    where: { email: "owner@hairsimo.local" },
    update: {},
    create: {
      email: "owner@hairsimo.local",
      passwordHash: "dev-only-change-me",
      firstName: "Simo",
      lastName: "Owner",
      locale: "de",
    },
  });

  const staff = await prisma.user.upsert({
    where: { email: "staff@hairsimo.local" },
    update: {},
    create: {
      email: "staff@hairsimo.local",
      passwordHash: "dev-only-change-me",
      firstName: "Giulia",
      lastName: "Stylist",
      locale: "it",
    },
  });

  await prisma.staffProfile.upsert({
    where: { userId: owner.id },
    update: { displayName: "Simo" },
    create: { userId: owner.id, displayName: "Simo", locale: "de" },
  });

  const staffProfile = await prisma.staffProfile.upsert({
    where: { userId: staff.id },
    update: { displayName: "Giulia" },
    create: { userId: staff.id, displayName: "Giulia", locale: "it" },
  });

  const services = await prisma.service.findMany();
  for (const service of services) {
    await prisma.staffService.upsert({
      where: { staffId_serviceId: { staffId: staffProfile.id, serviceId: service.id } },
      update: {},
      create: { staffId: staffProfile.id, serviceId: service.id },
    });
  }

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: owner.id, roleId: ownerRole.id } },
    update: {},
    create: { userId: owner.id, roleId: ownerRole.id },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: staff.id, roleId: staffRole.id } },
    update: {},
    create: { userId: staff.id, roleId: staffRole.id },
  });

  for (const dayOfWeek of [1, 2, 3, 4, 5]) {
    await prisma.staffAvailabilityRule.upsert({
      where: {
        id: `${staffProfile.id}-${dayOfWeek}`,
      },
      update: {},
      create: {
        id: `${staffProfile.id}-${dayOfWeek}`,
        staffId: staffProfile.id,
        dayOfWeek,
        startMin: 9 * 60,
        endMin: 18 * 60,
      },
    });
  }

  await prisma.customer.upsert({
    where: { email: "maria@example.com" },
    update: {},
    create: {
      email: "maria@example.com",
      phone: "+41790000000",
      firstName: "Maria",
      lastName: "Rossi",
      locale: "it",
      sourceChannel: "web",
      marketingOptIn: true,
    },
  });
}

async function seedInventory() {
  await prisma.inventoryItem.upsert({
    where: { sku: "SHAMPOO-001" },
    update: { quantity: 10 },
    create: { sku: "SHAMPOO-001", name: "Hydrating Shampoo", quantity: 10 },
  });
  await prisma.product.upsert({
    where: { sku: "PROD-ARGAN-50" },
    update: { stock: 5 },
    create: { sku: "PROD-ARGAN-50", name: "Argan Repair Oil", priceCents: 2900, stock: 5 },
  });
}

async function main() {
  await seedRoles();
  await seedServices();
  await seedBusinessHours();
  await seedStaffAndCustomer();
  await seedInventory();
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
