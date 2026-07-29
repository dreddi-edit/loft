import { runAssistant } from "@hair-simo/ai";
import { prisma } from "@hair-simo/db";
import { z } from "zod";
import { createAiTools } from "../../../../lib/ai-tools";
import { HttpError } from "../../../../lib/api-errors";
import { apiRoute } from "../../../../lib/api-handler";

const MAX_SIMULATED_UTTERANCE = 500;
const MAX_CALL_LOG_SUMMARY = 500;
const SIMULATE_BODY_LIMIT_BYTES = 4_096;

const simulateSchema = z.object({
  text: z.string().trim().min(1).max(MAX_SIMULATED_UTTERANCE),
  locale: z.enum(["de", "it", "fr", "en"]).optional(),
  fromNumber: z.string().trim().min(1).max(30).optional(),
});

/**
 * The simulator runs Gemini, Cloud TTS and writes a CallLog row without any credential.
 * That is acceptable while developing against the local stack; in production it is a paid
 * endpoint anybody can drive, so it has to be switched on deliberately.
 */
function assertSimulatorEnabled(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.VOICE_SIMULATOR_ENABLED === "true") return;
  throw new HttpError("NOT_FOUND", {
    logMessage: "voice simulator is disabled in production (set VOICE_SIMULATOR_ENABLED=true)",
  });
}

export const POST = apiRoute<z.infer<typeof simulateSchema>>(
  {
    route: "/api/voice/simulate",
    methods: ["POST"],
    policy: "voice",
    bodyLimitBytes: SIMULATE_BODY_LIMIT_BYTES,
    schema: simulateSchema,
  },
  async ({ body, log }) => {
    assertSimulatorEnabled();

    const result = await runAssistant(
      { text: body.text, locale: body.locale },
      createAiTools(body.locale),
    );
    const uncertain = body.text.length < 5;

    await prisma.callLog.create({
      data: {
        locale: result.locale,
        fromNumber: body.fromNumber ?? "local-simulator",
        toNumber: "voice-simulator",
        summary: `Intent ${result.intent}: ${result.response}`.slice(0, MAX_CALL_LOG_SUMMARY),
        actionTaken: uncertain ? "fallback-human-handover" : result.intent,
        fallback: uncertain,
      },
    });

    let audioBase64: string | null = null;
    try {
      const { isGcpConfigured } = await import("@hair-simo/gcp/config");
      const { synthesizeSpeechBase64 } = await import("@hair-simo/gcp/text-to-speech");
      if (isGcpConfigured()) {
        const audio = await synthesizeSpeechBase64({
          text: result.response.slice(0, MAX_SIMULATED_UTTERANCE),
          locale: result.locale,
        });
        audioBase64 = audio.audioBase64.length > 0 ? audio.audioBase64 : null;
      }
    } catch (error) {
      log.warn("simulated speech synthesis failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    return { data: { ...result, audioBase64, simulated: true } };
  },
);
