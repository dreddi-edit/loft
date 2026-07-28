import { PubSub } from "@google-cloud/pubsub";
import { getGcpConfig, isGcpConfigured } from "./config";

export type NotificationEvent = {
  type: "appointment.reminder" | "appointment.confirmation" | "chat.reply" | "voice.callback";
  channel: "email" | "sms" | "whatsapp" | "web";
  recipient: string;
  locale: "de" | "it" | "fr" | "en";
  payload: Record<string, unknown>;
};

let pubsubClient: PubSub | null = null;

function getClient(): PubSub {
  if (!pubsubClient) {
    pubsubClient = new PubSub({ projectId: getGcpConfig().projectId });
  }
  return pubsubClient;
}

export async function publishNotificationEvent(event: NotificationEvent): Promise<{ published: boolean; messageId?: string }> {
  if (!isGcpConfigured()) {
    console.info("[pubsub:local]", event);
    return { published: true, messageId: `local-${Date.now()}` };
  }

  const config = getGcpConfig();
  const topic = getClient().topic(config.pubsubTopicNotifications);
  const messageId = await topic.publishMessage({
    json: event,
    attributes: {
      type: event.type,
      channel: event.channel,
      locale: event.locale,
    },
  });

  return { published: true, messageId };
}
