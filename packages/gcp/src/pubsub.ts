import { getGcpAccessToken } from "./access-token";
import { getGcpConfig, isGcpConfigured } from "./config";

export type NotificationEvent = {
  type: "appointment.reminder" | "appointment.confirmation" | "chat.reply" | "voice.callback";
  channel: "email" | "sms" | "whatsapp" | "web";
  recipient: string;
  locale: "de" | "it" | "fr" | "en";
  payload: Record<string, unknown>;
};

export async function publishNotificationEvent(event: NotificationEvent): Promise<{ published: boolean; messageId?: string }> {
  if (!isGcpConfigured()) {
    console.info("[pubsub:local]", event);
    return { published: true, messageId: `local-${Date.now()}` };
  }

  const config = getGcpConfig();
  const token = await getGcpAccessToken();
  const topic = `projects/${config.projectId}/topics/${config.pubsubTopicNotifications}`;
  const data = Buffer.from(JSON.stringify(event)).toString("base64");

  const response = await fetch(`https://pubsub.googleapis.com/v1/${topic}:publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          data,
          attributes: {
            type: event.type,
            channel: event.channel,
            locale: event.locale,
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PUBSUB_FAILED:${response.status}:${errorText.slice(0, 300)}`);
  }

  const result = (await response.json()) as { messageIds?: string[] };
  return { published: true, messageId: result.messageIds?.[0] };
}
