import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../../../lib/auth";

const schema = z
  .object({
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; timeOffId: string }> },
) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const { id, timeOffId } = await params;
    const input = schema.parse(await request.json());
    const current = await salonRepository.findStaffTimeOff(id, timeOffId);
    if (!current) return NextResponse.json({ error: "TIME_OFF_NOT_FOUND" }, { status: 404 });
    const startsAt = input.startsAt ? new Date(input.startsAt) : current.startsAt;
    const endsAt = input.endsAt ? new Date(input.endsAt) : current.endsAt;
    if (endsAt <= startsAt) {
      return NextResponse.json({ error: "INVALID_TIME_RANGE" }, { status: 400 });
    }
    const data = await salonRepository.updateStaffTimeOff(id, timeOffId, {
      ...(input.startsAt ? { startsAt } : {}),
      ...(input.endsAt ? { endsAt } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; timeOffId: string }> },
) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const { id, timeOffId } = await params;
    return NextResponse.json({ data: await salonRepository.deleteStaffTimeOff(id, timeOffId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "DELETE_FAILED" },
      { status: 400 },
    );
  }
}
