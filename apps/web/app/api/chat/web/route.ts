import { NextRequest, NextResponse } from "next/server";
import { aiRequestSchema, runAssistant } from "@hair-simo/ai";
import { salonRepository } from "@hair-simo/core";
import { aiTools } from "../../../../lib/ai-tools";
import { checkRateLimit } from "../../../../lib/rate-limit";

export async function POST(request: NextRequest) {
  const client = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`chat-web:${client}`)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const payload = aiRequestSchema.parse(await request.json());
    const result = await runAssistant(payload, aiTools);

    await salonRepository.upsertConversationMessage({
      channel: "web",
      locale: payload.locale ?? result.locale,
      customerId: payload.customerId,
      role: "user",
      content: payload.text,
      externalRef: payload.customerId ? `web:${payload.customerId}` : `web:${client}`,
    });
    await salonRepository.upsertConversationMessage({
      channel: "web",
      locale: result.locale,
      customerId: payload.customerId,
      role: "assistant",
      content: result.response,
      externalRef: payload.customerId ? `web:${payload.customerId}` : `web:${client}`,
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      { error: "CHAT_REQUEST_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
