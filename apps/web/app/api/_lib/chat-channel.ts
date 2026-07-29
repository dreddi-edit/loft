import { runAssistant } from "@hair-simo/ai";
import { z } from "zod";
import { createAiTools } from "../../../lib/ai-tools";
import { apiRoute, type ApiRouteHandler, type RouteParams } from "../../../lib/api-handler";

/**
 * One inbound message is one Gemini call, so the text is capped as tightly as a real SMS
 * or WhatsApp turn needs. The byte cap stops a caller from paying for the parse of a
 * megabyte it was never allowed to send.
 */
export const MAX_CHAT_TEXT_LENGTH = 1_000;
export const CHAT_BODY_LIMIT_BYTES = 4_096;

export type ChatChannel = "sms" | "whatsapp";

const chatMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_CHAT_TEXT_LENGTH).optional(),
    message: z.string().trim().min(1).max(MAX_CHAT_TEXT_LENGTH).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).optional(),
  })
  .refine((value) => (value.text ?? value.message) !== undefined, {
    message: "Either text or message is required.",
    path: ["text"],
  });

export function chatChannelRoute(channel: ChatChannel): ApiRouteHandler<RouteParams> {
  return apiRoute(
    {
      route: `/api/chat/${channel}`,
      methods: ["POST"],
      policy: "chat",
      bodyLimitBytes: CHAT_BODY_LIMIT_BYTES,
      schema: chatMessageSchema,
    },
    async ({ body, log }) => {
      const text = body.text ?? body.message ?? "";
      const result = await runAssistant({ text, locale: body.locale }, createAiTools(body.locale));
      log.info("assistant replied", { channel, intent: result.intent, provider: result.provider });
      return {
        channel,
        reply: result.response,
        locale: result.locale,
        intent: result.intent,
        provider: result.provider,
      };
    },
  );
}
