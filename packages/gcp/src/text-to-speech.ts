import { getGcpAccessToken } from "./access-token";
import { getTtsVoiceForLocale, isGcpConfigured } from "./config";

export type SynthesisResult = {
  audioContent: Buffer;
  mimeType: string;
};

export async function synthesizeSpeech(input: {
  text: string;
  locale: "de" | "it" | "fr" | "en";
}): Promise<SynthesisResult> {
  if (!isGcpConfigured()) {
    return { audioContent: Buffer.alloc(0), mimeType: "audio/mpeg" };
  }

  const token = await getGcpAccessToken();
  const voiceName = getTtsVoiceForLocale(input.locale);
  const languageCode = voiceName.split("-").slice(0, 2).join("-");

  const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: { text: input.text },
      voice: {
        languageCode,
        name: voiceName,
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 1.0,
        pitch: 0,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TTS_REQUEST_FAILED:${response.status}:${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as { audioContent?: string };
  return {
    audioContent: data.audioContent ? Buffer.from(data.audioContent, "base64") : Buffer.alloc(0),
    mimeType: "audio/mpeg",
  };
}

export async function synthesizeSpeechBase64(input: {
  text: string;
  locale: "de" | "it" | "fr" | "en";
}): Promise<{ audioBase64: string; mimeType: string }> {
  const result = await synthesizeSpeech(input);
  return {
    audioBase64: result.audioContent.toString("base64"),
    mimeType: result.mimeType,
  };
}
