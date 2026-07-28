import { NextRequest, NextResponse } from "next/server";
import { NotificationService } from "@hair-simo/core";
import { z } from "zod";

const schema = z.object({
  appointmentId: z.string().min(1),
  channel: z.enum(["web", "whatsapp", "sms", "voice"]),
  recipient: z.string().min(3),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
  timeLabel: z.string().min(1),
});

const notificationService = new NotificationService();

export async function POST(request: NextRequest) {
  try {
    const payload = schema.parse(await request.json());
    const result = await notificationService.sendAppointmentReminder(payload);
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "REMINDER_CREATE_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
