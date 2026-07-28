import { NextRequest, NextResponse } from "next/server";
import { BookingService } from "@hair-simo/core";
import { checkRateLimit } from "../../../lib/rate-limit";

const bookingService = new BookingService();

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
      locale: String(body.locale ?? "en"),
      sourceChannel: String(body.sourceChannel ?? "web"),
      staffId: body.staffId ? String(body.staffId) : undefined,
    });
    return NextResponse.json({ data: appointment }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "BOOKING_CREATE_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
