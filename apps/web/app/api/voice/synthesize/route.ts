import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const synthesizeSchema = z.object({
  text: z.string().min(1).max(5000),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
});

export async function POST(request: NextRequest) {
  try {
    const input = synthesizeSchema.parse(await request.json());
    const { synthesizeSpeechBase64 } = await import("@hair-simo/gcp");
    const result = await synthesizeSpeechBase64(input);
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      { error: "TTS_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
