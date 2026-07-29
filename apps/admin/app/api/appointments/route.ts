import { NextRequest, NextResponse } from "next/server";
import { BookingService, salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../lib/auth";

const bookingService = new BookingService();
const statusSchema = z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]);
const querySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    status: z.string().optional(),
    staffId: z.string().trim().min(1).optional(),
    customerId: z.string().trim().min(1).optional(),
    serviceId: z.string().trim().min(1).optional(),
    query: z.string().trim().max(200).optional(),
    offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const statuses = input.status
      ? input.status
          .split(",")
          .filter(Boolean)
          .map((status) => statusSchema.parse(status))
      : undefined;
    const appointments = await salonRepository.listAppointments({
      from: input.from ? new Date(input.from) : undefined,
      to: input.to ? new Date(input.to) : undefined,
      statuses,
      staffId: input.staffId,
      customerId: input.customerId,
      serviceId: input.serviceId,
      query: input.query,
      skip: input.offset,
      take: input.limit,
    });
    return NextResponse.json({ data: appointments });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const body = await request.json();
    const appointment = await bookingService.createBooking(body);
    return NextResponse.json({ data: appointment }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CREATE_FAILED" },
      { status: 400 },
    );
  }
}
