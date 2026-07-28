import { NextRequest, NextResponse } from "next/server";
import { runAssistant } from "@hair-simo/ai";
import { aiTools } from "../../../../lib/ai-tools";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text ?? body.message ?? "");
  const result = await runAssistant({ text, locale: body.locale }, aiTools);
  return NextResponse.json({
    channel: "sms",
    reply: result.response,
    locale: result.locale,
    intent: result.intent,
    provider: "vertex-ai-gemini",
  });
}
