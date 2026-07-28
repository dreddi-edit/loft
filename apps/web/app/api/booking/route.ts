import { NextRequest, NextResponse } from "next/server";
import {
  BookingService,
  NotificationService,
  createAppointmentAccessToken,
} from "@hair-simo/core";
import { checkRateLimit } from "../../../lib/rate-limit";

const bookingService = new BookingService();
const notificationService = new NotificationService();

async function parseBody(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return request.json();
  const formData = await request.formData();
  return Object.fromEntries(formData.entries());
}

export async function POST(request: NextRequest) {
  const client = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`booking:${client}`)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const body = await parseBody(request);
    const appointment = await bookingService.createBooking({
      serviceSlug: String(body.serviceSlug),
      startsAt: String(body.startsAt),
      customerEmail: String(body.customerEmail),
      customerFirstName: body.customerFirstName ? String(body.customerFirstName) : undefined,
      customerLastName: body.customerLastName ? String(body.customerLastName) : undefined,
      customerPhone: body.customerPhone ? String(body.customerPhone) : undefined,
      locale: String(body.locale ?? "en"),
      sourceChannel: String(body.sourceChannel ?? "web"),
      staffId: body.staffId ? String(body.staffId) : undefined,
      marketingOptIn: body.marketingOptIn === true || body.marketingOptIn === "true",
      termsAccepted: body.termsAccepted === true || body.termsAccepted === "true",
    });

    const manageToken = await createAppointmentAccessToken({
      appointmentId: appointment.id,
      customerId: appointment.customerId,
    });
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    const manageUrl = `${baseUrl}/${appointment.locale}/manage/${manageToken}`;

    if (appointment.customer.email) {
      await notificationService.sendBookingConfirmation({
        appointmentId: appointment.id,
        recipient: appointment.customer.email,
        locale: (appointment.locale as "de" | "it" | "fr" | "en") ?? "en",
        timeLabel: new Date(appointment.startsAt).toLocaleString(appointment.locale),
        manageUrl,
      });
    }

    return NextResponse.json({ data: { ...appointment, manageToken, manageUrl } }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "BOOKING_CREATE_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
