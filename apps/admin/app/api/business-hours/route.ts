import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../lib/auth";

const schema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMin: z.number().int().min(0).max(1439),
    endMin: z.number().int().min(1).max(1440),
    isOpen: z.boolean(),
  })
  .strict()
  .refine((input) => !input.isOpen || input.endMin > input.startMin, "INVALID_TIME_RANGE");

export async function GET(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const hours = await salonRepository.listBusinessHours();
    return NextResponse.json({ data: hours });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const input = schema.parse(await request.json());
    const updated = await salonRepository.upsertBusinessHours(
      input.dayOfWeek,
      input.startMin,
      input.endMin,
      input.isOpen,
    );
    return NextResponse.json({ data: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}
