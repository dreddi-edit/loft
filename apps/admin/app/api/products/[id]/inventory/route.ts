import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../../lib/auth";

export const inventoryAdjustmentSchema = z
  .object({
    quantity: z
      .number()
      .int()
      .refine((value) => value !== 0),
    type: z.enum(["adjustment", "purchase", "sale", "return"]).default("adjustment"),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const limit = Math.min(
      500,
      Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 100)),
    );
    return NextResponse.json({
      data: await salonRepository.listProductInventoryMovements(id, limit),
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
    const input = inventoryAdjustmentSchema.parse(await request.json());
    return NextResponse.json(
      {
        data: await salonRepository.adjustProductStock(id, input),
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}
