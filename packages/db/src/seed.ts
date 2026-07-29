import { type RoleKey } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "./client";

const locales = ["de", "it", "fr", "en"] as const;

const team = [
  { email: "simona@hairsimo.it", firstName: "Simona", lastName: "", role: "owner" as RoleKey, locale: "it" },
  { email: "daniela@hairsimo.it", firstName: "Daniela", lastName: "", role: "staff" as RoleKey, locale: "it" },
  { email: "helga@hairsimo.it", firstName: "Helga", lastName: "", role: "staff" as RoleKey, locale: "de" },
  { email: "tina@hairsimo.it", firstName: "Tina", lastName: "", role: "staff" as RoleKey, locale: "de" },
];

async function seedRoles() {
  for (const key of ["owner", "manager", "staff"] as RoleKey[]) {
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
      slug: "balayage-straehnen",
      category: "color",
      durationMin: 150,
      priceCents: 12000,
      translations: {
        de: { name: "Balayage & Strähnchen", description: "Natürliche Farbverläufe und individuelle Highlights." },
        it: { name: "Balayage e colpi di sole", description: "Sfumature naturali e riflessi personalizzati." },
        fr: { name: "Balayage & mèches", description: "Dégradés naturels et reflets personnalisés." },
        en: { name: "Balayage & highlights", description: "Natural color transitions and personalized highlights." },
      },
    },
    {
      slug: "damen-schnitt",
      category: "cut",
      durationMin: 60,
      priceCents: 4500,
      translations: {
        de: { name: "Damenhaarschnitt", description: "Waschen, Schneiden und Föhnen." },
        it: { name: "Taglio donna", description: "Lavaggio, taglio e piega." },
        fr: { name: "Coupe femme", description: "Shampooing, coupe et brushing." },
        en: { name: "Women's haircut", description: "Wash, cut, and blow-dry." },
      },
    },
    {
      slug: "herren-schnitt",
      category: "cut",
      durationMin: 45,
      priceCents: 3000,
      translations: {
        de: { name: "Herrenhaarschnitt", description: "Präziser Schnitt und Styling." },
        it: { name: "Taglio uomo", description: "Taglio preciso e styling." },
        fr: { name: "Coupe homme", description: "Coupe précise et coiffage." },
        en: { name: "Men's haircut", description: "Precise cut and styling." },
      },
    },
    {
      slug: "kinder-schnitt",
      category: "cut",
      durationMin: 30,
      priceCents: 2500,
      translations: {
        de: { name: "Kinderhaarschnitt", description: "Sanfter Schnitt für die Kleinsten." },
        it: { name: "Taglio bambini", description: "Taglio delicato per i più piccoli." },
        fr: { name: "Coupe enfant", description: "Coupe douce pour les plus jeunes." },
        en: { name: "Children's haircut", description: "Gentle cut for kids." },
      },
    },
    {
      slug: "behandlung",
      category: "treatment",
      durationMin: 90,
      priceCents: 6500,
      translations: {
        de: { name: "Haarbehandlung", description: "Keratin, Masken und Pflege mit Vaporizer." },
        it: { name: "Trattamento capelli", description: "Cheratina, maschere e cura con vaporizzatore." },
        fr: { name: "Soin capillaire", description: "Kératine, masques et soin au vaporisateur." },
        en: { name: "Hair treatment", description: "Keratin, masks, and vaporizer care." },
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
      const translation = service.translations[locale];
      await prisma.serviceTranslation.upsert({
        where: { serviceId_locale: { serviceId: created.id, locale } },
        update: { name: translation.name, description: translation.description },
        create: { serviceId: created.id, locale, name: translation.name, description: translation.description },
      });
    }
  }
}

async function seedBusinessHours() {
  await prisma.businessHours.deleteMany();
  const ranges = [
    { id: "day-0", dayOfWeek: 0, startMin: 0, endMin: 0, isOpen: false },
    { id: "day-1", dayOfWeek: 1, startMin: 0, endMin: 0, isOpen: false },
    { id: "day-2", dayOfWeek: 2, startMin: 8 * 60, endMin: 17 * 60, isOpen: true },
    { id: "day-3", dayOfWeek: 3, startMin: 8 * 60, endMin: 16 * 60, isOpen: true },
    { id: "day-4", dayOfWeek: 4, startMin: 8 * 60, endMin: 17 * 60, isOpen: true },
    { id: "day-5", dayOfWeek: 5, startMin: 8 * 60, endMin: 17 * 60, isOpen: true },
    { id: "day-6", dayOfWeek: 6, startMin: 8 * 60, endMin: 16 * 60, isOpen: true },
  ];
  await prisma.businessHours.createMany({ data: ranges });
}

async function removeLegacyDemoData() {
  await prisma.customer.deleteMany({
    where: { email: { in: ["maria@example.com"] } },
  });
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          "owner@hairsimo.local",
          "manager@hairsimo.local",
          "staff@hairsimo.local",
        ],
      },
    },
  });
  await prisma.service.deleteMany({
    where: { slug: { in: ["haircut-women", "color-root-touchup", "mens-cut"] } },
  });
  await prisma.product.deleteMany({
    where: { sku: { in: ["PROD-ARGAN-50"] } },
  });
  await prisma.inventoryItem.deleteMany({
    where: { sku: { in: ["SHAMPOO-001"] } },
  });
}

async function seedTeam(passwordHash: string) {
  const services = await prisma.service.findMany();
  const roles = Object.fromEntries(
    (await prisma.role.findMany()).map((role) => [role.key, role.id]),
  ) as Record<RoleKey, string>;

  for (const member of team) {
    const user = await prisma.user.upsert({
      where: { email: member.email },
      update: {
        passwordHash,
        firstName: member.firstName,
        lastName: member.lastName,
        locale: member.locale,
        active: true,
      },
      create: {
        email: member.email,
        passwordHash,
        firstName: member.firstName,
        lastName: member.lastName,
        locale: member.locale,
      },
    });

    const staffProfile = await prisma.staffProfile.upsert({
      where: { userId: user.id },
      update: {
        displayName: member.firstName,
        locale: member.locale,
        isBookable: true,
      },
      create: {
        userId: user.id,
        displayName: member.firstName,
        locale: member.locale,
        isBookable: true,
      },
    });

    for (const service of services) {
      await prisma.staffService.upsert({
        where: { staffId_serviceId: { staffId: staffProfile.id, serviceId: service.id } },
        update: {},
        create: { staffId: staffProfile.id, serviceId: service.id },
      });
    }

    for (const dayOfWeek of [2, 3, 4, 5, 6]) {
      const endMin = dayOfWeek === 3 || dayOfWeek === 6 ? 16 * 60 : 17 * 60;
      await prisma.staffAvailabilityRule.upsert({
        where: { id: `${staffProfile.id}-${dayOfWeek}` },
        update: { startMin: 8 * 60, endMin },
        create: {
          id: `${staffProfile.id}-${dayOfWeek}`,
          staffId: staffProfile.id,
          dayOfWeek,
          startMin: 8 * 60,
          endMin,
        },
      });
    }

    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: roles[member.role] },
    });
  }
}

async function seedProducts() {
  const products = [
    { sku: "DAVINES-OI-SHAMPOO", name: "Davines OI Shampoo", priceCents: 2800, stock: 12 },
    { sku: "DAVINES-OI-MASK", name: "Davines OI Hair Butter", priceCents: 3400, stock: 10 },
    { sku: "DAVINES-LOVE-SPRAY", name: "Davines Love Curl Spray", priceCents: 2600, stock: 8 },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: { sku: product.sku },
      update: product,
      create: product,
    });
  }
}

async function main() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("SEED_ADMIN_PASSWORD must be set (min 12 chars) before seeding.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await removeLegacyDemoData();
  await seedRoles();
  await seedServices();
  await seedBusinessHours();
  await seedTeam(passwordHash);
  await seedProducts();
  console.info("Seed complete for Hair Simo Bressanone.");
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
