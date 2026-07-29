import { NextRequest, NextResponse } from "next/server";
import { NotificationService } from "@hair-simo/core";
import { requireSession } from "../../../../../lib/auth";

const notificationService = new NotificationService();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request, ["owner", "manager"]);
    const { id } = await params;
    return NextResponse.json({ data: await notificationService.retry(id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "RETRY_FAILED" },
      { status: 400 },
    );
  }
}
