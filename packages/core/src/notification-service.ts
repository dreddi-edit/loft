import { prisma } from "@hair-simo/db";
import { reminderTemplates } from "@hair-simo/i18n";
import type { Channel } from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";

type SendPayload = {
  channel: Channel;
  recipient: string;
  subject?: string;
  message: string;
  locale?: AppLocale;
};

async function sendViaPubSub(payload: SendPayload) {
  try {
    const { publishNotificationEvent } = await import("@hair-simo/gcp/pubsub");
    const outboundChannel =
      payload.channel === "web" ? "email" : payload.channel === "voice" ? "sms" : payload.channel;
    const result = await publishNotificationEvent({
      type: payload.channel === "web" ? "chat.reply" : "appointment.reminder",
      channel: outboundChannel as "email" | "sms" | "whatsapp",
      recipient: payload.recipient,
      locale: payload.locale ?? "en",
      payload: {
        subject: payload.subject ?? "Hair Simo",
        message: payload.message,
      },
    });
    return { delivered: result.published, provider: "gcp-pubsub", messageId: result.messageId };
  } catch {
    return { delivered: false, provider: "gcp-pubsub", reason: "PUBSUB_NOT_CONFIGURED" };
  }
}

async function sendViaGmail(payload: SendPayload) {
  const senderEmail = process.env.GCP_GMAIL_SENDER?.trim();
  if (!senderEmail) {
    console.info("[notification:email:local]", {
      to: payload.recipient,
      subject: payload.subject ?? "Hair Simo",
      message: payload.message,
    });
    return { delivered: true, provider: "gmail-log" };
  }

  try {
    const { isGcpConfigured } = await import("@hair-simo/gcp/config");
    if (!isGcpConfigured()) {
      console.info("[notification:email:local-gcp-missing]", {
        to: payload.recipient,
        subject: payload.subject ?? "Hair Simo",
        message: payload.message,
      });
      return { delivered: true, provider: "gmail-log" };
    }

    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
    });
    const gmail = google.gmail({ version: "v1", auth });
    const raw = [
      `From: ${senderEmail}`,
      `To: ${payload.recipient}`,
      `Subject: ${payload.subject ?? "Hair Simo"}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      payload.message,
    ].join("\r\n");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: Buffer.from(raw).toString("base64url") },
    });

    return { delivered: true, provider: "gmail-api" };
  } catch (error) {
    console.error("[notification:gmail-error]", error);
    return { delivered: false, provider: "gmail-api", reason: "GMAIL_SEND_FAILED" };
  }
}

async function scheduleReminderTask(
  payload: SendPayload,
  appointmentId: string,
  delaySeconds: number,
) {
  try {
    const { enqueueTask } = await import("@hair-simo/gcp/cloud-tasks");
    const result = await enqueueTask(
      {
        type: "notification.send",
        data: {
          channel: payload.channel,
          recipient: payload.recipient,
          message: payload.message,
          appointmentId,
        },
      },
      delaySeconds,
    );
    return { scheduled: result.enqueued, taskName: result.taskName };
  } catch {
    return { scheduled: false };
  }
}

export class NotificationService {
  async send(payload: SendPayload) {
    if (payload.channel === "web") {
      const emailResult = await sendViaGmail(payload);
      if (emailResult.delivered) return emailResult;
    }

    if (
      payload.channel === "sms" ||
      payload.channel === "whatsapp" ||
      payload.channel === "voice"
    ) {
      return sendViaPubSub(payload);
    }

    return sendViaPubSub(payload);
  }

  async sendAppointmentReminder(input: {
    appointmentId: string;
    channel: Channel;
    recipient: string;
    locale: AppLocale;
    timeLabel: string;
    scheduleDelaySeconds?: number;
  }) {
    const template = reminderTemplates[input.locale] ?? reminderTemplates.en;
    const message = template.replace("{{time}}", input.timeLabel);

    if (input.scheduleDelaySeconds && input.scheduleDelaySeconds > 0) {
      await scheduleReminderTask(
        {
          channel: input.channel,
          recipient: input.recipient,
          subject: "Hair Simo Appointment Reminder",
          message,
          locale: input.locale,
        },
        input.appointmentId,
        input.scheduleDelaySeconds,
      );
    }

    const delivery = await this.send({
      channel: input.channel,
      recipient: input.recipient,
      subject: "Hair Simo Appointment Reminder",
      message,
      locale: input.locale,
    });

    const record = await prisma.notificationLog.create({
      data: {
        appointmentId: input.appointmentId,
        channel: input.channel,
        recipient: input.recipient,
        templateKey: "appointment.reminder.v1",
        payload: { locale: input.locale, message, delivery },
        sentAt: delivery.delivered ? new Date() : null,
      },
    });

    return { record, delivery };
  }

  async wasReminderSent(appointmentId: string) {
    const existing = await prisma.notificationLog.findFirst({
      where: {
        appointmentId,
        templateKey: "appointment.reminder.v1",
        sentAt: { not: null },
      },
    });
    return Boolean(existing);
  }

  async sendBookingConfirmation(input: {
    appointmentId: string;
    recipient: string;
    locale: AppLocale;
    timeLabel: string;
    manageUrl?: string;
  }) {
    const message = `Your Hair Simo appointment is booked for ${input.timeLabel}.${input.manageUrl ? ` Manage: ${input.manageUrl}` : ""}`;
    return this.send({
      channel: "web",
      recipient: input.recipient,
      subject: "Hair Simo Booking Confirmation",
      message,
      locale: input.locale,
    });
  }

  async retry(notificationId: string) {
    const log = await prisma.notificationLog.findUnique({ where: { id: notificationId } });
    if (!log) throw new Error("NOTIFICATION_NOT_FOUND");
    const payload =
      typeof log.payload === "object" && log.payload !== null && !Array.isArray(log.payload)
        ? log.payload
        : {};
    const message = typeof payload.message === "string" ? payload.message : null;
    if (!message) throw new Error("NOTIFICATION_PAYLOAD_INVALID");
    const locale =
      payload.locale === "de" ||
      payload.locale === "it" ||
      payload.locale === "fr" ||
      payload.locale === "en"
        ? payload.locale
        : "en";
    const delivery = await this.send({
      channel: log.channel,
      recipient: log.recipient,
      message,
      locale,
    });
    const record = await prisma.notificationLog.update({
      where: { id: notificationId },
      data: {
        sentAt: delivery.delivered ? new Date() : null,
        payload: { ...payload, delivery, retriedAt: new Date().toISOString() },
      },
    });
    return { record, delivery };
  }
}
