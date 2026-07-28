import { NextRequest, NextResponse } from "next/server";
import { BookingService } from "@hair-simo/core";

const bookingService = new BookingService();

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const serviceSlug = params.get("serviceSlug");
  const day = params.get("day");
  const staffId = params.get("staffId") ?? undefined;
  if (!serviceSlug || !day) {
    return NextResponse.json({ error: "VALIDATION_ERROR", message: "serviceSlug and day are required" }, { status: 400 });
  }

  try {
    const slots = await bookingService.getAvailability(serviceSlug, day, staffId);
    return NextResponse.json({ data: slots });
  } catch (error) {
    return NextResponse.json(
      { error: "AVAILABILITY_ERROR", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
