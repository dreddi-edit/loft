import { NextRequest, NextResponse } from "next/server";
import { salonRepository } from "@hair-simo/core";
import { requireSession } from "../../../../lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession(request, ["owner", "manager", "staff"]);
    const { id } = await params;
    const body = await request.json();
    const customer = await salonRepository.updateCustomer(id, body);
    return NextResponse.json({ data: customer });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UPDATE_FAILED" }, { status: 400 });
  }
}
