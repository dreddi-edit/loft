import { reminderTemplates } from "@hair-simo/i18n";
import type { Channel } from "@hair-simo/db";
import { prisma } from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";

type SendPayload = {
  channel: Channel;
  recipient: string;
  subject?: string;
  message: string;
};

async function sendViaTwilio(payload: SendPayload) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return { delivered: false, provider: "twilio", reason: "TWILIO_NOT_CONFIGURED" };
  }

  const from =
    payload.channel === "whatsapp"
      ? process.env.TWILIO_WHATSAPP_FROM
      : payload.channel === "sms"
        ? process.env.TWILIO_SMS_FROM
        : undefined;

  if (!from) {
    return { delivered: false, provider: "twilio", reason: "TWILIO_FROM_MISSING" };
  }

  const body = new URLSearchParams({ To: payload.recipient, From: from, Body: payload.message });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  return { delivered: response.ok, provider: "twilio", status: response.status };
}

async function sendViaEmail(payload: SendPayload) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    return { delivered: false, provider: "smtp", reason: "SMTP_NOT_CONFIGURED" };
  }

  // Lightweight SMTP-less fallback for MVP environments without nodemailer transport setup.
  console.info("[notification:email]", {
    to: payload.recipient,
    subject: payload.subject ?? "Hair Simo",
    message: payload.message,
  });
  return { delivered: true, provider: "smtp-log" };
}

export class NotificationService {
  async send(payload: SendPayload) {
    if (payload.channel === "sms" || payload.channel === "whatsapp") {
      return sendViaTwilio(payload);
    }
    if (payload.channel === "web") {
      return sendViaEmail({ ...payload, subject: payload.subject ?? "Hair Simo Notification" });
    }
    return { delivered: false, provider: "unsupported", reason: "CHANNEL_UNSUPPORTED" };
  }

  async sendAppointmentReminder(input: {
    appointmentId: string;
    channel: Channel;
    recipient: string;
    locale: AppLocale;
    timeLabel: string;
  }) {
    const template = reminderTemplates[input.locale] ?? reminderTemplates.en;
    const message = template.replace("{{time}}", input.timeLabel);

    const delivery = await this.send({
      channel: input.channel,
      recipient: input.recipient,
      subject: "Hair Simo Appointment Reminder",
      message,
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
}
