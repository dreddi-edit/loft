import { NotificationService } from "@hair-simo/core";
import type { NotificationEvent } from "@hair-simo/gcp/pubsub";
import { z } from "zod";
import { HttpError } from "../../../../lib/api-errors";
import { apiRoute } from "../../../../lib/api-handler";
import { verifyPubSubPushToken } from "../../../../lib/pubsub-push-auth";

const notificationService = new NotificationService();

const PUBSUB_BODY_LIMIT_BYTES = 65_536;

const pubsubEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

function decodeEvent(data: string): NotificationEvent {
  const json = Buffer.from(data, "base64").toString("utf8");
  const parsed = JSON.parse(json) as NotificationEvent;
  if (!parsed.channel || !parsed.recipient || !parsed.payload) {
    throw new Error("PUBSUB_PAYLOAD_INVALID");
  }
  return parsed;
}

export const POST = apiRoute<z.infer<typeof pubsubEnvelopeSchema>>(
  {
    route: "/api/tasks/pubsub",
    methods: ["POST"],
    policy: "internal",
    bodyLimitBytes: PUBSUB_BODY_LIMIT_BYTES,
    schema: pubsubEnvelopeSchema,
  },
  async ({ body, req, log }) => {
    const audience = `${new URL(req.url).origin}/api/tasks/pubsub`;
    await verifyPubSubPushToken(req.headers, audience);

    let event: NotificationEvent;
    try {
      event = decodeEvent(body.message.data);
    } catch (error) {
      throw new HttpError("VALIDATION_ERROR", {
        message: "The Pub/Sub message could not be decoded.",
        cause: error,
        logMessage: error instanceof Error ? error.message : String(error),
      });
    }

    const delivery = await notificationService.deliverPubSubEvent({
      channel: event.channel,
      recipient: event.recipient,
      locale: event.locale,
      payload: event.payload,
    });

    if (delivery.status === "failed") {
      log.error("pubsub notification delivery failed", {
        channel: event.channel,
        provider: delivery.provider,
        reason: delivery.reason,
        messageId: body.message.messageId,
      });
      throw new HttpError("UPSTREAM_UNAVAILABLE", {
        message: "Notification delivery failed.",
        logMessage: delivery.reason ?? "DELIVERY_FAILED",
      });
    }

    return { ok: true, status: delivery.status, messageId: body.message.messageId };
  },
);
