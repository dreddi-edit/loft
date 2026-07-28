import { TextToSpeechClient } from "@google-cloud/text-to-speech";
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

  const client = new TextToSpeechClient();
  const voiceName = getTtsVoiceForLocale(input.locale);

  const [response] = await client.synthesizeSpeech({
    input: { text: input.text },
    voice: {
      languageCode: voiceName.split("-").slice(0, 2).join("-"),
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: 1.0,
      pitch: 0,
    },
  });

  const audioContent = response.audioContent
    ? Buffer.from(response.audioContent as Uint8Array)
    : Buffer.alloc(0);

  return { audioContent, mimeType: "audio/mpeg" };
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
