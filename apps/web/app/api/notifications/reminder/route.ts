import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@hair-simo/db";
import { z } from "zod";

const schema = z.object({
  appointmentId: z.string().min(1),
  channel: z.enum(["web", "whatsapp", "sms", "voice"]),
  recipient: z.string().min(3),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
});

export async function POST(request: NextRequest) {
  try {
    const payload = schema.parse(await request.json());
    const record = await prisma.notificationLog.create({
      data: {
        appointmentId: payload.appointmentId,
        channel: payload.channel,
        recipient: payload.recipient,
        templateKey: "appointment.reminder.v1",
        payload: {
          locale: payload.locale,
          message: "Reminder template placeholder for anti-no-show automation.",
        },
      },
    });
    return NextResponse.json({ data: record }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "REMINDER_CREATE_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
