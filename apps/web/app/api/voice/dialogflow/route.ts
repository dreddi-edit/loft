import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@hair-simo/db";
import { runAssistant } from "@hair-simo/ai";
import { aiTools } from "../../../../lib/ai-tools";

export async function POST(request: NextRequest) {
  try {
    const {
      parseDialogflowWebhook,
      buildDialogflowPlayAudioResponse,
      buildDialogflowResponse,
      synthesizeSpeechBase64,
    } = await import("@hair-simo/gcp");

    const body = await request.json();
    const parsed = parseDialogflowWebhook(body);
    const uncertain = parsed.text.trim().length < 5 || parsed.confidence < 0.5;

    const result = await runAssistant(
      {
        text: parsed.text,
        locale: parsed.locale,
        serviceId: String(parsed.parameters.serviceId ?? "haircut-women"),
        appointmentId: parsed.parameters.appointmentId ? String(parsed.parameters.appointmentId) : undefined,
      },
      aiTools,
    );

    await prisma.callLog.create({
      data: {
        locale: result.locale,
        fromNumber: parsed.session,
        toNumber: "dialogflow-cx",
        summary: `Intent ${result.intent}: ${result.response}`,
        actionTaken: uncertain ? "fallback-human-handover" : result.intent,
        fallback: uncertain,
      },
    });

    const message = uncertain
      ? "Sorry, I could not confidently process your request. We will call you back shortly."
      : result.response;

    const audio = await synthesizeSpeechBase64({ text: message, locale: result.locale });
    const response =
      audio.audioBase64.length > 0
        ? buildDialogflowPlayAudioResponse({
            text: message,
            audioBase64: audio.audioBase64,
            locale: result.locale,
          })
        : buildDialogflowResponse(message, { intent: result.intent, locale: result.locale });

    return NextResponse.json(response);
  } catch {
    const { buildDialogflowResponse } = await import("@hair-simo/gcp");
    const fallback = buildDialogflowResponse(
      "An error occurred. Please try again or call us directly.",
    );
    return NextResponse.json(fallback, { status: 200 });
  }
}
