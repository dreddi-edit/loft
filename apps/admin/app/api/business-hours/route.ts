import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const hours = await salonRepository.listBusinessHours();
    return NextResponse.json({ data: hours });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "AUTH_ERROR" }, { status: 403 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const body = await request.json();
    const updated = await salonRepository.upsertBusinessHours(
      Number(body.dayOfWeek),
      Number(body.startMin),
      Number(body.endMin),
      Boolean(body.isOpen),
    );
    return NextResponse.json({ data: updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UPDATE_FAILED" }, { status: 400 });
  }
}
