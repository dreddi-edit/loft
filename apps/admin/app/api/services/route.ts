import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../lib/auth";

const schema = z
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
      .min(1)
      .max(4),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const services = await salonRepository.listServices(true);
    return NextResponse.json({ data: services });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const input = schema.parse(await request.json());
    const service = await salonRepository.createService(input);
    return NextResponse.json({ data: service }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CREATE_FAILED" },
      { status: 400 },
    );
  }
}
