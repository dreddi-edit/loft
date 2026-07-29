import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../../lib/auth";

const ruleSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMin: z.number().int().min(0).max(1439),
    endMin: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((rule) => rule.endMin > rule.startMin, "INVALID_TIME_RANGE");

const schema = z
  .object({
    rules: z.array(ruleSchema).max(100),
  })
  .strict();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    return NextResponse.json({ data: await salonRepository.listStaffAvailability(id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AUTH_ERROR" },
      { status: 403 },
    );
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const { id } = await params;
    const input = schema.parse(await request.json());
    return NextResponse.json({
      data: await salonRepository.replaceStaffAvailability(id, input.rules),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}
