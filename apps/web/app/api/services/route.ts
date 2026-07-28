import { NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";

export async function GET() {
  const services = await salonRepository.listServices();
  return NextResponse.json({
    data: services.map((service) => ({
      id: service.id,
      slug: service.slug,
      category: service.category,
      durationMin: service.durationMin,
      priceCents: service.priceCents,
      translations: service.translations,
    })),
  });
}
