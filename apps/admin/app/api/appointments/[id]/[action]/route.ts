import { NextRequest, NextResponse } from "next/server";
import { BookingService, salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../../../lib/auth";

const bookingService = new BookingService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id, action } = await params;
    const body = await request.json();

    if (action === "reschedule") {
      const data = await bookingService.reschedule(id, String(body.startsAt));
      return NextResponse.json({ data });
    }
    if (action === "cancel") {
      const data = await bookingService.cancel(id, String(body.reason ?? "cancelled by staff"));
      return NextResponse.json({ data });
    }
    if (action === "confirm") {
      const data = await bookingService.confirm(id, "confirmed by staff");
      return NextResponse.json({ data });
    }
    if (action === "no_show") {
      const data = await salonRepository.updateAppointmentStatus(id, "no_show", "marked no-show");
      return NextResponse.json({ data });
    }
    if (action === "complete") {
      const data = await salonRepository.updateAppointmentStatus(id, "completed", "marked completed");
      return NextResponse.json({ data });
    }

    return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ACTION_FAILED" }, { status: 400 });
  }
}
