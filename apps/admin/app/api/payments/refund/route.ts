import { NextRequest, NextResponse } from "next/server";
import { RefundService } from "@hair-simo/core";
import { requireSession } from "../../../../lib/auth";

const refundService = new RefundService();

export async function POST(request: NextRequest) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const body = await request.json();
    const refund = await refundService.createRefund(body);
    return NextResponse.json({ data: refund }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "REFUND_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
