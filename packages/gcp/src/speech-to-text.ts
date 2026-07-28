import { v1 as speechV1 } from "@google-cloud/speech";
import { isGcpConfigured, getGcpConfig } from "./config";

export type TranscriptionResult = {
  transcript: string;
  confidence: number;
  locale: "de" | "it" | "fr" | "en";
};

function localeFromLanguageCode(code: string): "de" | "it" | "fr" | "en" {
  if (code.startsWith("de")) return "de";
  if (code.startsWith("it")) return "it";
  if (code.startsWith("fr")) return "fr";
  return "en";
}

export async function transcribeAudio(input: {
  audioContent: Buffer | Uint8Array;
  encoding?: "LINEAR16" | "OGG_OPUS" | "MP3" | "WEBM_OPUS";
  sampleRateHertz?: number;
}): Promise<TranscriptionResult> {
  if (!isGcpConfigured()) {
    return { transcript: "", confidence: 0, locale: "en" };
  }

  const config = getGcpConfig();
  const client = new speechV1.SpeechClient();

  const [response] = await client.recognize({
    config: {
      encoding: input.encoding ?? "WEBM_OPUS",
      sampleRateHertz: input.sampleRateHertz ?? 48000,
      languageCode: config.sttLanguageCodes[0],
      alternativeLanguageCodes: config.sttLanguageCodes.slice(1),
      model: "chirp",
      enableAutomaticPunctuation: true,
    },
    audio: { content: Buffer.from(input.audioContent).toString("base64") },
  });

  const best = response.results?.[0]?.alternatives?.[0];
  const languageCode = response.results?.[0]?.languageCode ?? config.sttLanguageCodes[0];

  return {
    transcript: best?.transcript ?? "",
    confidence: best?.confidence ?? 0,
    locale: localeFromLanguageCode(languageCode),
  };
}

export async function transcribeFromGcs(gcsUri: string): Promise<TranscriptionResult> {
  if (!isGcpConfigured()) {
    return { transcript: "", confidence: 0, locale: "en" };
  }

  const config = getGcpConfig();
  const client = new speechV1.SpeechClient();

  const [operation] = await client.longRunningRecognize({
    config: {
      languageCode: config.sttLanguageCodes[0],
      alternativeLanguageCodes: config.sttLanguageCodes.slice(1),
      model: "chirp",
      enableAutomaticPunctuation: true,
    },
    audio: { uri: gcsUri },
  });

  const [response] = await operation.promise();
  const best = response.results?.[0]?.alternatives?.[0];
  const languageCode = response.results?.[0]?.languageCode ?? config.sttLanguageCodes[0];

  return {
    transcript: best?.transcript ?? "",
    confidence: best?.confidence ?? 0,
    locale: localeFromLanguageCode(languageCode),
  };
}
