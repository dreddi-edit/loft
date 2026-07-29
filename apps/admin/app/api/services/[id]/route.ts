import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../lib/auth";

const schema = z
  .object({
    category: z.string().trim().min(1).max(100).optional(),
    durationMin: z.number().int().min(5).max(720).optional(),
    bufferAfterMin: z.number().int().min(0).max(180).optional(),
    priceCents: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
    translations: z
      .array(
        z
          .object({
            locale: z.enum(["de", "it", "fr", "en"]),
            name: z.string().trim().min(1).max(200),
            description: z.string().trim().max(5000),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const data = await salonRepository.findServiceById(id);
    if (!data) return NextResponse.json({ error: "SERVICE_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const { id } = await params;
    const input = schema.parse(await request.json());
    const { translations, ...serviceInput } = input;
    await salonRepository.updateService(id, serviceInput);
    if (translations) {
      await Promise.all(
        translations.map((translation) =>
          salonRepository.upsertServiceTranslation(
            id,
            translation.locale,
            translation.name,
            translation.description,
          ),
        ),
      );
    }
    return NextResponse.json({ data: await salonRepository.findServiceById(id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}
