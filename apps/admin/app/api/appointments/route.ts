import { NextRequest, NextResponse } from "next/server";
import { BookingService, salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../lib/auth";

const bookingService = new BookingService();

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const appointments = await salonRepository.listAppointments();
    return NextResponse.json({ data: appointments });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "AUTH_ERROR" }, { status: 403 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const body = await request.json();
    const appointment = await bookingService.createBooking(body);
    return NextResponse.json({ data: appointment }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CREATE_FAILED" }, { status: 400 });
  }
}
