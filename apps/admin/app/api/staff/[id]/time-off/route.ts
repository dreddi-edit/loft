import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../../lib/auth";

const schema = z
  .object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((input) => new Date(input.endsAt) > new Date(input.startsAt), "INVALID_TIME_RANGE");

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const from = request.nextUrl.searchParams.get("from");
    const to = request.nextUrl.searchParams.get("to");
    const startsAt = from ? new Date(from) : new Date(0);
    const endsAt = to ? new Date(to) : new Date("9999-12-31T23:59:59.999Z");
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return NextResponse.json({ error: "INVALID_DATE_RANGE" }, { status: 400 });
    }
    return NextResponse.json({
      data: await salonRepository.listStaffTimeOff(id, startsAt, endsAt),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const { id } = await params;
    const input = schema.parse(await request.json());
    const data = await salonRepository.createStaffTimeOff(id, {
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      reason: input.reason,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CREATE_FAILED" },
      { status: 400 },
    );
  }
}
