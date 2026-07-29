import { NextRequest, NextResponse } from "next/server";
import { BookingService, salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../../lib/auth";

const bookingService = new BookingService();
const actionSchema = z.enum(["reschedule", "cancel", "confirm", "no_show", "complete"]);
const rescheduleSchema = z.object({ startsAt: z.string().datetime() }).strict();
const cancelSchema = z
  .object({ reason: z.string().trim().min(1).max(500).default("cancelled by staff") })
  .strict();
const emptySchema = z.object({}).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id, action: rawAction } = await params;
    const action = actionSchema.parse(rawAction);
    const body = await request.json();

    if (action === "reschedule") {
      const input = rescheduleSchema.parse(body);
      const data = await bookingService.reschedule(id, input.startsAt);
      return NextResponse.json({ data });
    }
    if (action === "cancel") {
      const input = cancelSchema.parse(body);
      const data = await bookingService.cancel(id, input.reason);
      return NextResponse.json({ data });
    }
    emptySchema.parse(body);
    if (action === "confirm") {
      const data = await bookingService.confirm(id, "confirmed by staff");
      return NextResponse.json({ data });
    }
    if (action === "no_show") {
      const data = await salonRepository.updateAppointmentStatus(id, "no_show", "marked no-show");
      return NextResponse.json({ data });
    }
    if (action === "complete") {
      const data = await salonRepository.updateAppointmentStatus(
        id,
        "completed",
        "marked completed",
      );
      return NextResponse.json({ data });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ACTION_FAILED" },
      { status: 400 },
    );
  }
}
