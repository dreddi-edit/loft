import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@hair-simo/db";
import { detectIntent, detectLocaleFromInput, runIntentTooling } from "@hair-simo/ai";
import { aiTools } from "../../../../lib/ai-tools";
import { checkRateLimit } from "../../../../lib/rate-limit";

function toTwiml(message: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">${message}</Say></Response>`;
}

export async function POST(request: NextRequest) {
  const client = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`voice:${client}`)) {
    return new NextResponse(toTwiml("Too many requests, please try again later."), {
      status: 429,
      headers: { "Content-Type": "application/xml" },
    });
  }
  const form = await request.formData();
  const speech = String(form.get("SpeechResult") ?? form.get("Body") ?? "");
  const fromNumber = String(form.get("From") ?? "");
  const locale = detectLocaleFromInput(speech);
  const intent = detectIntent(speech);

  const result = await runIntentTooling({ text: speech, locale }, aiTools);
  const uncertain = speech.trim().length < 5;

  await prisma.callLog.create({
    data: {
      locale,
      fromNumber,
      toNumber: String(form.get("To") ?? ""),
      summary: `Intent ${intent}: ${result.response}`,
      actionTaken: uncertain ? "fallback-human-handover" : intent,
      fallback: uncertain,
    },
  });

  const message = uncertain
    ? "Sorry, I could not confidently process your request. We will call you back shortly."
    : result.response;

  return new NextResponse(toTwiml(message), {
    headers: { "Content-Type": "application/xml" },
  });
}
