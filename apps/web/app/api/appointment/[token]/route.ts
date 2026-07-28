import { NextRequest, NextResponse } from "next/server";
import { BookingService, createAppointmentAccessToken, salonRepository } from "@hair-simo/core";

const bookingService = new BookingService();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { verifyAppointmentAccessToken } = await import("@hair-simo/core");
    const { token } = await params;
    const access = await verifyAppointmentAccessToken(token);
    const appointment = await salonRepository.findAppointmentById(access.appointmentId);
    if (!appointment || appointment.customerId !== access.customerId) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ data: appointment });
  } catch (error) {
    return NextResponse.json(
      { error: "INVALID_TOKEN", message: error instanceof Error ? error.message : "unknown error" },
      { status: 401 },
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { verifyAppointmentAccessToken } = await import("@hair-simo/core");
    const { token } = await params;
    const access = await verifyAppointmentAccessToken(token);
    const body = await request.json();
    const action = String(body.action ?? "");

    if (action === "cancel") {
      const appointment = await bookingService.cancel(access.appointmentId, String(body.reason ?? "customer request"));
      return NextResponse.json({ data: appointment });
    }

    if (action === "reschedule") {
      const appointment = await bookingService.reschedule(access.appointmentId, String(body.startsAt));
      return NextResponse.json({ data: appointment });
    }

    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: "MANAGE_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}

export async function createManageTokenForAppointment(appointmentId: string, customerId: string) {
  return createAppointmentAccessToken({ appointmentId, customerId });
}
