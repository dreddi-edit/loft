import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const audioFile = form.get("audio");
    if (!(audioFile instanceof Blob)) {
      return NextResponse.json({ error: "AUDIO_REQUIRED" }, { status: 400 });
    }

    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const encoding = String(form.get("encoding") ?? "WEBM_OPUS") as "LINEAR16" | "OGG_OPUS" | "MP3" | "WEBM_OPUS";
    const sampleRateHertz = Number(form.get("sampleRateHertz") ?? 48000);

    const { transcribeAudio } = await import("@hair-simo/gcp/speech-to-text");
    const result = await transcribeAudio({ audioContent: buffer, encoding, sampleRateHertz });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      { error: "STT_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
