import { salonRepository } from "@hair-simo/core";
import { apiRoute } from "../../../lib/api-handler";

export const GET = apiRoute(
  { route: "/api/services", methods: ["GET"], policy: "publicRead" },
  async () => {
    const services = await salonRepository.listServices();
    return {
      data: services.map((service) => ({
        id: service.id,
        slug: service.slug,
        category: service.category,
        durationMin: service.durationMin,
        priceCents: service.priceCents,
        translations: service.translations,
      })),
    };
  },
);
