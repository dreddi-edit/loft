import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const services = await salonRepository.listServices(true);
    return NextResponse.json({ data: services });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "AUTH_ERROR" }, { status: 403 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const body = await request.json();
    const service = await salonRepository.createService({
      slug: String(body.slug),
      category: String(body.category),
      durationMin: Number(body.durationMin),
      bufferAfterMin: Number(body.bufferAfterMin ?? 10),
      priceCents: Number(body.priceCents),
      translations: body.translations ?? [],
    });
    return NextResponse.json({ data: service }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CREATE_FAILED" }, { status: 400 });
  }
}
