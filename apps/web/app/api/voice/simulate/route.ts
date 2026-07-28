import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@hair-simo/db";
import { runAssistant } from "@hair-simo/ai";
import { aiTools } from "../../../../lib/ai-tools";

const simulateSchema = z.object({
  text: z.string().min(1),
  locale: z.enum(["de", "it", "fr", "en"]).optional(),
  fromNumber: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const input = simulateSchema.parse(await request.json());
    const result = await runAssistant(
      {
        text: input.text,
        locale: input.locale,
      },
      aiTools,
    );

    const uncertain = input.text.trim().length < 5;
    await prisma.callLog.create({
      data: {
        locale: result.locale,
        fromNumber: input.fromNumber ?? "local-simulator",
        toNumber: "voice-simulator",
        summary: `Intent ${result.intent}: ${result.response}`,
        actionTaken: uncertain ? "fallback-human-handover" : result.intent,
        fallback: uncertain,
      },
    });

    let audioBase64: string | null = null;
    try {
      const { synthesizeSpeechBase64, isGcpConfigured } = await import("@hair-simo/gcp");
      if (isGcpConfigured()) {
        const audio = await synthesizeSpeechBase64({ text: result.response, locale: result.locale });
        audioBase64 = audio.audioBase64.length > 0 ? audio.audioBase64 : null;
      }
    } catch {
      // Local dev: text-only response is fine
    }

    return NextResponse.json({
      data: {
        ...result,
        audioBase64,
        simulated: true,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "VOICE_SIMULATION_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
