import { NextRequest, NextResponse } from "next/server";
import { BookingService } from "@hair-simo/core";

const bookingService = new BookingService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const result = await bookingService.reschedule(id, String(body.startsAt));
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      { error: "BOOKING_RESCHEDULE_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
