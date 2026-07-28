import { NextRequest, NextResponse } from "next/server";
import { ReminderService } from "@hair-simo/core";

const reminderService = new ReminderService();

function isAuthorized(request: NextRequest) {
  const secret = process.env.GCP_CLOUD_TASKS_SECRET ?? process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const withinHours = Number(body.withinHours ?? 24);
    const result = await reminderService.dispatchDueReminders(withinHours);
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      { error: "REMINDER_BATCH_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 500 },
    );
  }
}
