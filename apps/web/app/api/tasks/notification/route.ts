import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { NotificationService } from "@hair-simo/core";

const taskSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const notificationService = new NotificationService();

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.GCP_CLOUD_TASKS_SECRET;
  if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const payload = taskSchema.parse(await request.json());
    if (payload.type === "notification.send") {
      const channel = String(payload.data.channel ?? "web") as "web" | "sms" | "whatsapp" | "voice";
      await notificationService.send({
        channel,
        recipient: String(payload.data.recipient ?? ""),
        message: String(payload.data.message ?? ""),
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: "TASK_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
