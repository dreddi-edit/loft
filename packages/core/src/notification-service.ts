import { prisma } from "@hair-simo/db";
import { reminderTemplates, resolveLocale } from "@hair-simo/i18n";
import type { Channel, NotificationLog, NotificationStatus } from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";

export const REMINDER_TEMPLATE_KEY = "appointment.reminder.v1";
export const CONFIRMATION_TEMPLATE_KEY = "appointment.confirmation.v1";
export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * A claimed row is "in flight". If the process dies between claiming and finalising,
 * the row would block every later attempt forever, so an in-flight claim that has not
 * been finalised within this window may be taken over. Scheduled rows carry attempts=0
 * and are deliberately never taken over: their Cloud Task may fire much later.
 */
const STALE_CLAIM_MS = 15 * 60_000;
const LAST_ERROR_MAX_LENGTH = 500;
const DEFAULT_SUBJECT = "Hair Simo";
const REMINDER_SUBJECT = "Hair Simo Appointment Reminder";
const CONFIRMATION_SUBJECT = "Hair Simo Booking Confirmation";

const OUTBOUND_CHANNEL: Record<Channel, "email" | "sms" | "whatsapp"> = {
  web: "email",
  whatsapp: "whatsapp",
  sms: "sms",
  voice: "sms",
};

type OutboundEventType =
  "appointment.reminder" | "appointment.confirmation" | "chat.reply" | "voice.callback";

/**
 * The result of one delivery attempt.
 *
 * `simulated` means the message was written to the log and nothing left the process.
 * It is NOT a delivery and must never set `sentAt`; it only exists outside production.
 * `scheduled` means a Cloud Task owns the delivery and nothing was sent yet.
 */
export type DeliveryStatus = "sent" | "simulated" | "scheduled" | "failed" | "skipped";

export type DeliveryOutcome = {
  status: DeliveryStatus;
  provider: string;
  reason?: string;
  detail?: string;
  messageId?: string;
  taskName?: string;
};

export type NotificationEnvelope = {
  locale: AppLocale;
  subject: string;
  message: string;
};

export type NotificationResult = {
  record: NotificationLog | null;
  delivery: DeliveryOutcome;
};

type SendPayload = {
  channel: Channel;
  recipient: string;
  subject?: string;
  message: string;
  locale?: AppLocale;
  eventType?: OutboundEventType;
};

type ClaimMode = "immediate" | "scheduled";

type ClaimState = { status: NotificationStatus; attempts: number; updatedAt: Date };

/**
 * Thrown when the process cannot deliver anything at all because the transport is not
 * configured. In production that is a deployment fault affecting every customer, so it
 * has to surface instead of degrading into a log line.
 */
export class NotificationTransportError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "NotificationTransportError";
    this.reason = reason;
  }
}

export function isDelivered(outcome: DeliveryOutcome): boolean {
  return outcome.status === "sent";
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function maskRecipient(recipient: string): string {
  const separator = recipient.indexOf("@");
  if (separator > 0) return `${recipient.slice(0, 2)}***${recipient.slice(separator)}`;
  return `${recipient.slice(0, 3)}***`;
}

function skipped(reason: string): DeliveryOutcome {
  return { status: "skipped", provider: "none", reason };
}

/**
 * The single place where "we did not actually send anything" is decided. Outside
 * production it degrades to a simulated send that is recorded as such; in production it
 * is a hard failure, because a missing sender there means no customer receives anything.
 */
function transportNotConfigured(
  payload: SendPayload,
  provider: string,
  reason: string,
): DeliveryOutcome {
  const context = {
    provider,
    reason,
    channel: payload.channel,
    recipient: maskRecipient(payload.recipient),
  };
  if (isProduction()) {
    console.error("[notification:transport-not-configured]", context);
    throw new NotificationTransportError(reason);
  }
  console.info("[notification:simulated]", {
    ...context,
    subject: payload.subject ?? DEFAULT_SUBJECT,
    message: payload.message,
  });
  return { status: "simulated", provider, reason };
}

async function sendViaPubSub(payload: SendPayload): Promise<DeliveryOutcome> {
  const { isGcpConfigured } = await import("@hair-simo/gcp/config");
  if (!isGcpConfigured()) {
    return transportNotConfigured(payload, "gcp-pubsub", "GCP_NOT_CONFIGURED");
  }

  try {
    const { publishNotificationEvent } = await import("@hair-simo/gcp/pubsub");
    const result = await publishNotificationEvent({
      type:
        payload.eventType ?? (payload.channel === "web" ? "chat.reply" : "appointment.reminder"),
      channel: OUTBOUND_CHANNEL[payload.channel],
      recipient: payload.recipient,
      locale: payload.locale ?? "en",
      payload: {
        subject: payload.subject ?? DEFAULT_SUBJECT,
        message: payload.message,
      },
    });
    if (!result.published) {
      return { status: "failed", provider: "gcp-pubsub", reason: "PUBSUB_NOT_PUBLISHED" };
    }
    return { status: "sent", provider: "gcp-pubsub", messageId: result.messageId };
  } catch (error) {
    console.error("[notification:pubsub-error]", {
      recipient: maskRecipient(payload.recipient),
      error: errorMessage(error),
    });
    return {
      status: "failed",
      provider: "gcp-pubsub",
      reason: "PUBSUB_PUBLISH_FAILED",
      detail: errorMessage(error),
    };
  }
}

async function sendViaGmail(payload: SendPayload): Promise<DeliveryOutcome> {
  const senderEmail = process.env.GCP_GMAIL_SENDER?.trim();
  if (!senderEmail) {
    return transportNotConfigured(payload, "gmail", "GMAIL_SENDER_NOT_CONFIGURED");
  }

  const { isGcpConfigured } = await import("@hair-simo/gcp/config");
  if (!isGcpConfigured()) {
    return transportNotConfigured(payload, "gmail", "GCP_NOT_CONFIGURED");
  }

  try {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
    });
    const gmail = google.gmail({ version: "v1", auth });
    const raw = [
      `From: ${senderEmail}`,
      `To: ${payload.recipient}`,
      `Subject: ${payload.subject ?? DEFAULT_SUBJECT}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      payload.message,
    ].join("\r\n");

    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: Buffer.from(raw).toString("base64url") },
    });

    return { status: "sent", provider: "gmail-api", messageId: response.data.id ?? undefined };
  } catch (error) {
    console.error("[notification:gmail-error]", {
      recipient: maskRecipient(payload.recipient),
      error: errorMessage(error),
    });
    return {
      status: "failed",
      provider: "gmail-api",
      reason: "GMAIL_SEND_FAILED",
      detail: errorMessage(error),
    };
  }
}

async function scheduleNotificationTask(
  payload: SendPayload,
  appointmentId: string,
  notificationLogId: string,
  delaySeconds: number,
): Promise<DeliveryOutcome> {
  const { isGcpConfigured } = await import("@hair-simo/gcp/config");
  if (!isGcpConfigured()) {
    return transportNotConfigured(payload, "cloud-tasks", "GCP_NOT_CONFIGURED");
  }

  try {
    const { enqueueTask } = await import("@hair-simo/gcp/cloud-tasks");
    const result = await enqueueTask(
      {
        type: "notification.send",
        data: {
          channel: payload.channel,
          recipient: payload.recipient,
          subject: payload.subject ?? DEFAULT_SUBJECT,
          message: payload.message,
          locale: payload.locale ?? "en",
          appointmentId,
          notificationLogId,
        },
      },
      delaySeconds,
    );
    if (!result.enqueued) {
      return { status: "failed", provider: "cloud-tasks", reason: "TASK_NOT_ENQUEUED" };
    }
    return { status: "scheduled", provider: "cloud-tasks", taskName: result.taskName };
  } catch (error) {
    return {
      status: "failed",
      provider: "cloud-tasks",
      reason: "TASK_ENQUEUE_FAILED",
      detail: errorMessage(error),
    };
  }
}

function parseEnvelope(payload: unknown): NotificationEnvelope | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const message = typeof source.message === "string" ? source.message.trim() : "";
  if (message === "") return null;
  const subject = typeof source.subject === "string" ? source.subject.trim() : "";
  return {
    locale: resolveLocale(typeof source.locale === "string" ? source.locale : null),
    subject: subject === "" ? DEFAULT_SUBJECT : subject,
    message,
  };
}

/**
 * Can this notification be (re)attempted right now? `sent` and `abandoned` are terminal,
 * a fresh claim belongs to another runner, and the attempt cap stops infinite retrying.
 */
function isClaimable(state: ClaimState, now: Date): boolean {
  if (state.status === "sent" || state.status === "abandoned") return false;
  if (state.attempts >= MAX_DELIVERY_ATTEMPTS) return false;
  if (state.status === "pending") {
    return state.attempts > 0 && now.getTime() - state.updatedAt.getTime() >= STALE_CLAIM_MS;
  }
  return true;
}

function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2034" || code === "40001";
}

/**
 * Take exclusive ownership of the notification for `appointmentId` + `templateKey`
 * before anything is sent.
 *
 * Read and write happen in one Serializable transaction, so two cron runs that both
 * observe "no reminder yet" cannot both insert: Postgres detects the read/write conflict
 * on the same predicate and aborts one of them with 40001 (Prisma P2034), which we treat
 * as "somebody else owns it". The claimed row is written as `pending` with the attempt
 * already counted, so a crashed run is visible instead of silently retried forever.
 */
async function claimNotification(input: {
  appointmentId: string;
  channel: Channel;
  recipient: string;
  templateKey: string;
  envelope: NotificationEnvelope;
  mode: ClaimMode;
  now: Date;
}): Promise<NotificationLog | null> {
  const attemptDelta = input.mode === "immediate" ? 1 : 0;
  try {
    return await prisma.$transaction(
      async (tx) => {
        const rows = await tx.notificationLog.findMany({
          where: { appointmentId: input.appointmentId, templateKey: input.templateKey },
          orderBy: { createdAt: "desc" },
        });
        if (rows.some((row) => !isClaimable(row, input.now))) return null;

        const takeover = rows[0];
        const payload = { ...input.envelope };
        if (takeover) {
          return tx.notificationLog.update({
            where: { id: takeover.id },
            data: {
              channel: input.channel,
              recipient: input.recipient,
              payload,
              status: "pending",
              attempts: { increment: attemptDelta },
              lastError: null,
            },
          });
        }
        return tx.notificationLog.create({
          data: {
            appointmentId: input.appointmentId,
            channel: input.channel,
            recipient: input.recipient,
            templateKey: input.templateKey,
            payload,
            status: "pending",
            attempts: attemptDelta,
          },
        });
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (isSerializationConflict(error)) return null;
    throw error;
  }
}

/**
 * `simulated` maps to `abandoned` because it is terminal and undelivered: nothing left the
 * process and retrying it would only simulate again. NotificationStatus has no `simulated`
 * member, and `sent` would be the exact lie this service exists to stop telling.
 */
function statusForOutcome(attempts: number, outcome: DeliveryOutcome): NotificationStatus {
  if (outcome.status === "sent") return "sent";
  if (outcome.status === "scheduled") return "pending";
  if (outcome.status === "simulated") return "abandoned";
  return attempts >= MAX_DELIVERY_ATTEMPTS ? "abandoned" : "failed";
}

function describeOutcome(outcome: DeliveryOutcome): string | null {
  if (outcome.status === "sent" || outcome.status === "scheduled") return null;
  const reason = `${outcome.status.toUpperCase()}:${outcome.reason ?? "UNKNOWN"}`;
  const described = outcome.detail ? `${reason} ${outcome.detail}` : reason;
  return described.slice(0, LAST_ERROR_MAX_LENGTH);
}

async function finalizeNotification(
  record: NotificationLog,
  outcome: DeliveryOutcome,
): Promise<NotificationLog> {
  return prisma.notificationLog.update({
    where: { id: record.id },
    data: {
      status: statusForOutcome(record.attempts, outcome),
      sentAt: outcome.status === "sent" ? new Date() : null,
      lastError: describeOutcome(outcome),
    },
  });
}

export class NotificationService {
  async send(payload: SendPayload): Promise<DeliveryOutcome> {
    if (payload.channel === "web") return sendViaGmail(payload);
    return sendViaPubSub(payload);
  }

  /**
   * Deliver, persist the outcome, and only then re-raise a transport fault. The row must
   * describe what happened even when the caller aborts on the exception.
   */
  private async deliverAndFinalize(
    record: NotificationLog,
    payload: SendPayload,
  ): Promise<NotificationResult> {
    let outcome: DeliveryOutcome;
    let fatal: NotificationTransportError | null = null;
    try {
      outcome = await this.send(payload);
    } catch (error) {
      fatal = error instanceof NotificationTransportError ? error : null;
      outcome = {
        status: "failed",
        provider: "unknown",
        reason: fatal?.reason ?? "DELIVERY_ERROR",
        detail: errorMessage(error),
      };
    }
    const saved = await finalizeNotification(record, outcome);
    if (fatal) throw fatal;
    return { record: saved, delivery: outcome };
  }

  async sendAppointmentReminder(input: {
    appointmentId: string;
    channel: Channel;
    recipient: string;
    locale: AppLocale;
    timeLabel: string;
    scheduleDelaySeconds?: number;
  }): Promise<NotificationResult> {
    const template = reminderTemplates[input.locale] ?? reminderTemplates.en;
    const message = template.replace("{{time}}", input.timeLabel);
    const envelope: NotificationEnvelope = {
      locale: input.locale,
      subject: REMINDER_SUBJECT,
      message,
    };
    const delaySeconds = input.scheduleDelaySeconds ?? 0;
    const scheduling = delaySeconds > 0;

    const record = await claimNotification({
      appointmentId: input.appointmentId,
      channel: input.channel,
      recipient: input.recipient,
      templateKey: REMINDER_TEMPLATE_KEY,
      envelope,
      mode: scheduling ? "scheduled" : "immediate",
      now: new Date(),
    });
    if (!record) return { record: null, delivery: skipped("REMINDER_ALREADY_HANDLED") };

    const payload: SendPayload = {
      channel: input.channel,
      recipient: input.recipient,
      subject: REMINDER_SUBJECT,
      message,
      locale: input.locale,
      eventType: "appointment.reminder",
    };

    if (scheduling) {
      const delivery = await scheduleNotificationTask(
        payload,
        input.appointmentId,
        record.id,
        delaySeconds,
      );
      return { record: await finalizeNotification(record, delivery), delivery };
    }

    return this.deliverAndFinalize(record, payload);
  }

  async wasReminderSent(appointmentId: string): Promise<boolean> {
    const existing = await prisma.notificationLog.findFirst({
      where: { appointmentId, templateKey: REMINDER_TEMPLATE_KEY, status: "sent" },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * One query for a whole batch instead of one per appointment. The returned ids must not
   * be reminded again right now; the Serializable claim inside `sendAppointmentReminder`
   * is what actually guarantees it, this only avoids the pointless work.
   */
  async listAppointmentsWithBlockedReminder(
    appointmentIds: string[],
    now = new Date(),
  ): Promise<Set<string>> {
    const blocked = new Set<string>();
    if (appointmentIds.length === 0) return blocked;
    const rows = await prisma.notificationLog.findMany({
      where: { appointmentId: { in: appointmentIds }, templateKey: REMINDER_TEMPLATE_KEY },
      select: { appointmentId: true, status: true, attempts: true, updatedAt: true },
    });
    for (const row of rows) {
      if (row.appointmentId === null) continue;
      if (!isClaimable(row, now)) blocked.add(row.appointmentId);
    }
    return blocked;
  }

  async sendBookingConfirmation(input: {
    appointmentId: string;
    recipient: string;
    locale: AppLocale;
    timeLabel: string;
    manageUrl?: string;
  }): Promise<NotificationResult> {
    const message = `Your Hair Simo appointment is booked for ${input.timeLabel}.${input.manageUrl ? ` Manage: ${input.manageUrl}` : ""}`;
    const payload: SendPayload = {
      channel: "web",
      recipient: input.recipient,
      subject: CONFIRMATION_SUBJECT,
      message,
      locale: input.locale,
      eventType: "appointment.confirmation",
    };

    let delivery: DeliveryOutcome;
    try {
      delivery = await this.send(payload);
    } catch (error) {
      delivery = {
        status: "failed",
        provider: "unknown",
        reason: error instanceof NotificationTransportError ? error.reason : "DELIVERY_ERROR",
        detail: errorMessage(error),
      };
    }

    const record = await prisma.notificationLog.create({
      data: {
        appointmentId: input.appointmentId,
        channel: "web",
        recipient: input.recipient,
        templateKey: CONFIRMATION_TEMPLATE_KEY,
        payload: { locale: input.locale, subject: CONFIRMATION_SUBJECT, message },
        status: statusForOutcome(1, delivery),
        attempts: 1,
        lastError: describeOutcome(delivery),
        sentAt: delivery.status === "sent" ? new Date() : null,
      },
    });
    return { record, delivery };
  }

  async retry(notificationId: string): Promise<NotificationResult> {
    const log = await prisma.notificationLog.findUnique({ where: { id: notificationId } });
    if (!log) throw new Error("NOTIFICATION_NOT_FOUND");
    const envelope = parseEnvelope(log.payload);
    if (!envelope) throw new Error("NOTIFICATION_PAYLOAD_INVALID");
    if (log.status === "sent") return { record: log, delivery: skipped("ALREADY_SENT") };

    if (log.attempts >= MAX_DELIVERY_ATTEMPTS) {
      const record =
        log.status === "abandoned"
          ? log
          : await prisma.notificationLog.update({
              where: { id: log.id },
              data: { status: "abandoned" },
            });
      return { record, delivery: skipped("ATTEMPTS_EXHAUSTED") };
    }

    const record = await prisma.notificationLog.update({
      where: { id: notificationId },
      data: { status: "pending", attempts: { increment: 1 }, lastError: null },
    });

    return this.deliverAndFinalize(record, {
      channel: record.channel,
      recipient: record.recipient,
      subject: envelope.subject,
      message: envelope.message,
      locale: envelope.locale,
      eventType:
        record.templateKey === CONFIRMATION_TEMPLATE_KEY
          ? "appointment.confirmation"
          : "appointment.reminder",
    });
  }
}
