import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { adminRoute, httpError } from "../../../../lib/admin-api";

/**
 * The editor round-trips whole translation rows, so the server-owned identifiers arrive
 * with them. They are accepted and dropped; only locale, name and description are written.
 */
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

const updateServiceSchema = z
  .object({
    // The slug is the public booking URL and the key the assistant books against, so it is
    // fixed after creation. It is accepted and ignored because the editor posts it back.
    slug: z.string().trim().max(100).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    durationMin: z.number().int().min(5).max(720).optional(),
    bufferAfterMin: z.number().int().min(0).max(180).optional(),
    priceCents: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
    translations: z.array(translationSchema).max(4).optional(),
  })
  .strict();

export const GET = adminRoute<unknown, undefined, { id: string }>(
  { roles: ["owner", "manager", "staff"], route: "/api/services/[id]" },
  async ({ params }) => {
    const data = await salonRepository.findServiceById(params.id);
    if (!data) throw httpError("SERVICE_NOT_FOUND");
    return { data };
  },
);

export const PATCH = adminRoute<z.infer<typeof updateServiceSchema>, undefined, { id: string }>(
  {
    roles: ["owner", "manager"],
    route: "/api/services/[id]",
    schema: updateServiceSchema,
    audit: { entityType: "service", action: "service.update", entityId: (params) => params.id },
  },
  async ({ body, params, audit }) => {
    const current = await salonRepository.findServiceById(params.id);
    if (!current) throw httpError("SERVICE_NOT_FOUND");
    audit.setBefore({
      category: current.category,
      durationMin: current.durationMin,
      bufferAfterMin: current.bufferAfterMin,
      priceCents: current.priceCents,
      isActive: current.isActive,
    });

    const { translations, slug, ...serviceInput } = body;
    void slug;
    await salonRepository.updateService(params.id, serviceInput);
    if (translations) {
      for (const translation of translations) {
        await salonRepository.upsertServiceTranslation(
          params.id,
          translation.locale,
          translation.name,
          translation.description,
        );
      }
    }

    const data = await salonRepository.findServiceById(params.id);
    if (!data) throw httpError("SERVICE_NOT_FOUND");
    audit.setAfter({
      category: data.category,
      durationMin: data.durationMin,
      bufferAfterMin: data.bufferAfterMin,
      priceCents: data.priceCents,
      isActive: data.isActive,
      ...(translations ? { locales: translations.map((entry) => entry.locale) } : {}),
    });
    return { data };
  },
);
