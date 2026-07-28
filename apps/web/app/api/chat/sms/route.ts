import { NextRequest, NextResponse } from "next/server";
import { runIntentTooling } from "@hair-simo/ai";
import { aiTools } from "../../../../../lib/ai-tools";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const text = String(form.get("Body") ?? "");
  const result = await runIntentTooling({ text, locale: undefined }, aiTools);
  return NextResponse.json({
    channel: "sms",
    reply: result.response,
    locale: result.locale,
    intent: result.intent,
  });
}
