import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute } from "../../../lib/admin-api";

const translationSchema = z
  .object({
    id: z.string().optional(),
    serviceId: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    locale: z.enum(["de", "it", "fr", "en"]),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000),
  })
  .strict()
  .transform((translation) => ({
    locale: translation.locale,
    name: translation.name,
    description: translation.description,
  }));

const createServiceSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    category: z.string().trim().min(1).max(100),
    durationMin: z.number().int().min(5).max(720),
    bufferAfterMin: z.number().int().min(0).max(180).default(10),
    priceCents: z.number().int().nonnegative(),
    // A service is created active; the flag exists so the editor can post its own draft
    // state back without a field-level rejection.
    isActive: z.boolean().optional(),
    translations: z.array(translationSchema).min(1).max(4),
  })
  .strict();

export const GET = adminRoute(
  { roles: ["owner", "manager", "staff"], route: "/api/services" },
  async () => ({ data: await salonRepository.listServices(true) }),
);

export const POST = adminRoute<z.infer<typeof createServiceSchema>>(
  {
    roles: ["owner", "manager"],
    route: "/api/services",
    schema: createServiceSchema,
    successStatus: 201,
    audit: { entityType: "service", action: "service.create" },
  },
  async ({ body, audit }) => {
    const service = await salonRepository.createService({
      slug: body.slug,
      category: body.category,
      durationMin: body.durationMin,
      bufferAfterMin: body.bufferAfterMin,
      priceCents: body.priceCents,
      translations: body.translations,
    });
    audit.setEntityId(service.id);
    audit.setAfter({
      id: service.id,
      slug: service.slug,
      category: service.category,
      durationMin: service.durationMin,
      bufferAfterMin: service.bufferAfterMin,
      priceCents: service.priceCents,
    });
    return { data: service };
  },
);
