import { randomUUID } from "node:crypto";
import { runAssistant } from "@hair-simo/ai";
import { prisma } from "@hair-simo/db";
import { NextResponse } from "next/server";
import { createAiTools } from "../../../../lib/ai-tools";
import { apiRoute } from "../../../../lib/api-handler";
import {
  DIALOGFLOW_WEBHOOK_SECRET,
  requireRouteSecret,
  verifyRouteSecret,
} from "../../_lib/route-secret";

/**
 * Dialogflow CX configuration (Agent > Manage > Webhooks > this webhook):
 *   Webhook URL          https://<service-host>/api/voice/dialogflow
 *   Subtype              Standard
 *   Authentication       "Custom headers" (Service agent auth / OIDC stays off)
 *   Header key           x-dialogflow-webhook-secret
 *   Header value         the value of GCP_DIALOGFLOW_WEBHOOK_SECRET
 * Set GCP_DIALOGFLOW_WEBHOOK_SECRET in Secret Manager and expose it to the Cloud Run
 * service; without it the route refuses to start in production. Rotate by adding the new
 * value in Dialogflow first, then flipping the environment variable.
 */
requireRouteSecret(DIALOGFLOW_WEBHOOK_SECRET);

const DIALOGFLOW_BODY_LIMIT_BYTES = 16_384;
const MAX_UTTERANCE_CHARS = 500;
const MAX_TTS_CHARS = 600;
const MAX_CALL_LOG_SUMMARY = 500;
const MAX_PARAMETER_CHARS = 100;
const UNCERTAIN_CONFIDENCE = 0.5;

const UNCERTAIN_MESSAGE =
  "Sorry, I could not confidently process your request. We will call you back shortly.";
const FAILURE_MESSAGE = "An error occurred. Please try again or call us directly.";

/**
 * Keys the booking draft on the Dialogflow session. `parseDialogflowWebhook` falls back to
 * the literal "unknown" when the payload carries no session, and every caller sharing one
 * draft key would mean one caller hearing another caller's name and e-mail read back, so
 * an unusable session gets a private, per-request key instead.
 */
function voiceConversationId(session: string): string {
  const sanitized = session.slice(0, 100).replace(/[^A-Za-z0-9._-]/g, "-");
  if (sanitized === "" || sanitized === "unknown") return `voice:${randomUUID()}`;
  return `voice:${sanitized}`;
}

function parameterString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text.slice(0, MAX_PARAMETER_CHARS);
}

export const POST = apiRoute(
  {
    route: "/api/voice/dialogflow",
    methods: ["POST"],
    // The caller is Google's infrastructure, so a per-address limit sized for a human
    // would throttle a single ten turn phone call. This is a blast radius cap on an
    // authenticated machine caller; the per-request work is bounded separately below.
    policy: "internal",
    bodyLimitBytes: DIALOGFLOW_BODY_LIMIT_BYTES,
  },
  async ({ req, body, log }) => {
    // Verified before anything else and outside the fallback below, so an unauthenticated
    // caller gets 401 instead of a friendly spoken error with a CallLog row behind it.
    verifyRouteSecret(DIALOGFLOW_WEBHOOK_SECRET, req.headers);

    const { parseDialogflowWebhook, buildDialogflowPlayAudioResponse, buildDialogflowResponse } =
      await import("@hair-simo/gcp/dialogflow");
    const parsed = parseDialogflowWebhook(body);

    try {
      const text = parsed.text.trim().slice(0, MAX_UTTERANCE_CHARS);
      const uncertain = text.length < 5 || parsed.confidence < UNCERTAIN_CONFIDENCE;

      // A phone caller proves nothing: there is no manage link on a voice channel, so no
      // access token is bound and the tools refuse to cancel or move any appointment. The
      // Dialogflow `appointmentId` parameter is deliberately not forwarded — it is caller
      // supplied speech, not proof of ownership. The session id keys the booking draft, so
      // one call can collect details across turns and confirm a new appointment.
      const result = await runAssistant(
        {
          text: text.length > 0 ? text : " ",
          locale: parsed.locale,
          serviceId: parameterString(parsed.parameters.serviceId),
        },
        createAiTools({
          locale: parsed.locale,
          channel: "voice",
          conversationId: voiceConversationId(parsed.session),
          log: (message, fields) => log.info(message, fields),
        }),
      );

      await prisma.callLog.create({
        data: {
          locale: result.locale,
          fromNumber: parsed.session.slice(0, MAX_PARAMETER_CHARS),
          toNumber: "dialogflow-cx",
          summary: `Intent ${result.intent}: ${result.response}`.slice(0, MAX_CALL_LOG_SUMMARY),
          actionTaken: uncertain ? "fallback-human-handover" : result.intent,
          fallback: uncertain,
        },
      });

      const message = uncertain ? UNCERTAIN_MESSAGE : result.response;
      if (message.length > MAX_TTS_CHARS) {
        log.warn("skipping speech synthesis for an oversized answer", {
          length: message.length,
        });
        return NextResponse.json(
          buildDialogflowResponse(message.slice(0, MAX_TTS_CHARS), {
            intent: result.intent,
            locale: result.locale,
          }),
        );
      }

      const { synthesizeSpeechBase64 } = await import("@hair-simo/gcp/text-to-speech");
      const audio = await synthesizeSpeechBase64({ text: message, locale: result.locale });
      return NextResponse.json(
        audio.audioBase64.length > 0
          ? buildDialogflowPlayAudioResponse({
              text: message,
              audioBase64: audio.audioBase64,
              locale: result.locale,
            })
          : buildDialogflowResponse(message, { intent: result.intent, locale: result.locale }),
      );
    } catch (error) {
      // The caller is a phone line: it has to be able to say something. The detail stays
      // in the structured log, never in the spoken response.
      log.error("dialogflow fulfilment failed", {
        session: parsed.session.slice(0, MAX_PARAMETER_CHARS),
        reason: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(buildDialogflowResponse(FAILURE_MESSAGE));
    }
  },
);
