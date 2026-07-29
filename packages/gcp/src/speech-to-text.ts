import { getGcpAccessToken } from "./access-token";
import { getGcpConfig, isGcpConfigured } from "./config";

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

type RecognizeResponse = {
  results?: Array<{
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
    languageCode?: string;
  }>;
};

export async function transcribeAudio(input: {
  audioContent: Buffer | Uint8Array;
  encoding?: "LINEAR16" | "OGG_OPUS" | "MP3" | "WEBM_OPUS";
  sampleRateHertz?: number;
}): Promise<TranscriptionResult> {
  if (!isGcpConfigured()) {
    return { transcript: "", confidence: 0, locale: "en" };
  }

  const config = getGcpConfig();
  const token = await getGcpAccessToken();

  const response = await fetch("https://speech.googleapis.com/v1/speech:recognize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      config: {
        encoding: input.encoding ?? "WEBM_OPUS",
        sampleRateHertz: input.sampleRateHertz ?? 48000,
        languageCode: config.sttLanguageCodes[0],
        alternativeLanguageCodes: config.sttLanguageCodes.slice(1),
        model: "latest_long",
        enableAutomaticPunctuation: true,
      },
      audio: { content: Buffer.from(input.audioContent).toString("base64") },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`STT_REQUEST_FAILED:${response.status}:${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as RecognizeResponse;
  const best = data.results?.[0]?.alternatives?.[0];
  const languageCode = data.results?.[0]?.languageCode ?? config.sttLanguageCodes[0];

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
  const token = await getGcpAccessToken();

  const start = await fetch("https://speech.googleapis.com/v1/speech:longrunningrecognize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      config: {
        languageCode: config.sttLanguageCodes[0],
        alternativeLanguageCodes: config.sttLanguageCodes.slice(1),
        model: "latest_long",
        enableAutomaticPunctuation: true,
      },
      audio: { uri: gcsUri },
    }),
  });

  if (!start.ok) {
    const errorText = await start.text();
    throw new Error(`STT_LONG_FAILED:${start.status}:${errorText.slice(0, 300)}`);
  }

  const operation = (await start.json()) as { name?: string; done?: boolean; response?: RecognizeResponse };
  if (operation.done && operation.response) {
    const best = operation.response.results?.[0]?.alternatives?.[0];
    const languageCode = operation.response.results?.[0]?.languageCode ?? config.sttLanguageCodes[0];
    return {
      transcript: best?.transcript ?? "",
      confidence: best?.confidence ?? 0,
      locale: localeFromLanguageCode(languageCode),
    };
  }

  const name = operation.name;
  if (!name) {
    return { transcript: "", confidence: 0, locale: "en" };
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const poll = await fetch(`https://speech.googleapis.com/v1/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!poll.ok) continue;
    const status = (await poll.json()) as { done?: boolean; response?: RecognizeResponse };
    if (!status.done) continue;
    const best = status.response?.results?.[0]?.alternatives?.[0];
    const languageCode = status.response?.results?.[0]?.languageCode ?? config.sttLanguageCodes[0];
    return {
      transcript: best?.transcript ?? "",
      confidence: best?.confidence ?? 0,
      locale: localeFromLanguageCode(languageCode),
    };
  }

  return { transcript: "", confidence: 0, locale: "en" };
}
