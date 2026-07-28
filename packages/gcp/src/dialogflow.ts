import { z } from "zod";

const dialogflowWebhookSchema = z.object({
  detectIntentResponseId: z.string().optional(),
  session: z.string().optional(),
  queryResult: z
    .object({
      queryText: z.string().optional(),
      languageCode: z.string().optional(),
      intent: z.object({ displayName: z.string().optional() }).optional(),
      fulfillmentText: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
      intentDetectionConfidence: z.number().optional(),
    })
    .optional(),
  originalDetectIntentRequest: z
    .object({
      payload: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type DialogflowWebhookRequest = z.infer<typeof dialogflowWebhookSchema>;

export type DialogflowWebhookResponse = {
  fulfillmentResponse: {
    messages: Array<{ text: { text: string[] } }>;
  };
  sessionInfo?: {
    parameters?: Record<string, unknown>;
  };
};

function localeFromLanguageCode(code?: string): "de" | "it" | "fr" | "en" {
  if (!code) return "en";
  if (code.startsWith("de")) return "de";
  if (code.startsWith("it")) return "it";
  if (code.startsWith("fr")) return "fr";
  return "en";
}

export function parseDialogflowWebhook(body: unknown): {
  text: string;
  locale: "de" | "it" | "fr" | "en";
  intent: string;
  confidence: number;
  session: string;
  parameters: Record<string, unknown>;
} {
  const parsed = dialogflowWebhookSchema.parse(body);
  const queryResult = parsed.queryResult;
  const text = queryResult?.queryText ?? "";
  const locale = localeFromLanguageCode(queryResult?.languageCode);
  const intent = queryResult?.intent?.displayName ?? "Default Fallback Intent";
  const confidence = queryResult?.intentDetectionConfidence ?? 0;
  const session = parsed.session ?? "unknown";
  const parameters = queryResult?.parameters ?? {};

  return { text, locale, intent, confidence, session, parameters };
}

export function buildDialogflowResponse(text: string, parameters?: Record<string, unknown>): DialogflowWebhookResponse {
  return {
    fulfillmentResponse: {
      messages: [{ text: { text: [text] } }],
    },
    sessionInfo: parameters ? { parameters } : undefined,
  };
}

export function buildDialogflowPlayAudioResponse(input: {
  text: string;
  audioBase64: string;
  locale: "de" | "it" | "fr" | "en";
}): DialogflowWebhookResponse {
  return {
    fulfillmentResponse: {
      messages: [
        { text: { text: [input.text] } },
      ],
    },
    sessionInfo: {
      parameters: {
        synthesizedAudio: input.audioBase64,
        synthesizedLocale: input.locale,
      },
    },
  };
}
