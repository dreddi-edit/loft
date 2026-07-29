import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../../lib/auth";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const data = await salonRepository.findAppointmentById(id);
    if (!data) return NextResponse.json({ error: "APPOINTMENT_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}
