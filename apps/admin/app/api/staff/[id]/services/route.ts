import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { z } from "zod";
import { requireSession } from "../../../../../lib/auth";

const schema = z
  .object({
    serviceIds: z.array(z.string().trim().min(1)).max(100),
  })
  .strict();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const staff = await salonRepository.findStaffById(id);
    if (!staff) return NextResponse.json({ error: "STAFF_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ data: staff.staffServices });
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
    const data = await salonRepository.replaceStaffServices(id, [...new Set(input.serviceIds)]);
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "UPDATE_FAILED" },
      { status: 400 },
    );
  }
}
