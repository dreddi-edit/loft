import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { NotificationService } from "@hair-simo/core";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  message: z.string().min(5),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
});

const notificationService = new NotificationService();

export async function POST(request: NextRequest) {
  try {
    const body = schema.parse(await request.json());
    const salonEmail = process.env.CONTACT_INBOX_EMAIL ?? "info@hairsimo.it";
    await notificationService.send({
      channel: "web",
      recipient: salonEmail,
      subject: `Contact form: ${body.name}`,
      message: `From: ${body.name} <${body.email}>\n\n${body.message}`,
      locale: body.locale,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: "CONTACT_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
