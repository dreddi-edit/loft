import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LogRow = {
  id: string;
  appointmentId: string | null;
  channel: string;
  recipient: string;
  templateKey: string;
  payload: Record<string, unknown>;
  status: "pending" | "sent" | "failed" | "abandoned";
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type WhereInput = Record<string, unknown>;

const { db, gmailSend, isGcpConfigured, publishNotificationEvent, enqueueTask } = vi.hoisted(() => {
  const rows: LogRow[] = [];
  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function matches(row: LogRow, where?: WhereInput): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (expected !== null && typeof expected === "object" && "in" in expected) {
        return (expected as { in: unknown[] }).in.includes(actual);
      }
      return actual === expected;
    });
  }

  function applyData(row: LogRow, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === "object" && "increment" in value) {
        const current = (row as unknown as Record<string, number>)[key] ?? 0;
        (row as unknown as Record<string, number>)[key] =
          current + (value as { increment: number }).increment;
        continue;
      }
      (row as unknown as Record<string, unknown>)[key] = value;
    }
    sequence += 1;
    row.updatedAt = new Date(Date.now() + sequence);
  }

  const notificationLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      sequence += 1;
      const row: LogRow = {
        id: `log-${sequence}`,
        appointmentId: null,
        channel: "web",
        recipient: "",
        templateKey: "",
        payload: {},
        status: "pending",
        attempts: 0,
        lastError: null,
        sentAt: null,
        createdAt: new Date(Date.now() + sequence),
        updatedAt: new Date(Date.now() + sequence),
      };
      applyData(row, data);
      rows.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: WhereInput }) => {
      const row = rows.find((entry) => entry.id === where.id);
      if (!row) throw new Error("RECORD_NOT_FOUND");
      applyData(row, data);
      return { ...row };
    }),
    findMany: vi.fn(async ({ where }: { where?: WhereInput }) =>
      rows
        .filter((row) => matches(row, where))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .map((row) => ({ ...row })),
    ),
    findFirst: vi.fn(async ({ where }: { where?: WhereInput }) => {
      const found = rows.find((row) => matches(row, where));
      return found ? { ...found } : null;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const found = rows.find((row) => row.id === where.id);
      return found ? { ...found } : null;
    }),
  };

  return {
    db: {
      rows,
      notificationLog,
      // Serializable in Postgres means the two transactions cannot interleave their
      // read/write on the same predicate, so running the callbacks one at a time is a
      // faithful model of what the database gives us.
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
        const settled = queue.then(() => run({ notificationLog }));
        queue = settled.catch(() => undefined);
        return settled;
      }),
      reset() {
        rows.length = 0;
        sequence = 0;
        queue = Promise.resolve();
      },
    },
    gmailSend: vi.fn(),
    isGcpConfigured: vi.fn(),
    publishNotificationEvent: vi.fn(),
    enqueueTask: vi.fn(),
  };
});

vi.mock("@hair-simo/db", () => ({
  prisma: { notificationLog: db.notificationLog, $transaction: db.$transaction },
}));

vi.mock("@hair-simo/gcp/config", () => ({ isGcpConfigured }));
vi.mock("@hair-simo/gcp/pubsub", () => ({ publishNotificationEvent }));
vi.mock("@hair-simo/gcp/cloud-tasks", () => ({ enqueueTask }));
vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: vi.fn() },
    gmail: () => ({ users: { messages: { send: gmailSend } } }),
  },
}));

import {
  MAX_DELIVERY_ATTEMPTS,
  NotificationService,
  NotificationTransportError,
  REMINDER_TEMPLATE_KEY,
} from "./notification-service";

const originalEnv = { ...process.env };

const reminder = {
  appointmentId: "appointment-1",
  channel: "web" as const,
  recipient: "guest@example.com",
  locale: "de" as const,
  timeLabel: "Di., 4. Aug. 2026, 08:00-09:15",
};

function sentBody(): string {
  const call = gmailSend.mock.calls.at(-1)?.[0] as { requestBody?: { raw?: string } } | undefined;
  return Buffer.from(call?.requestBody?.raw ?? "", "base64url").toString("utf8");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  process.env.NODE_ENV = "test";
  process.env.GCP_GMAIL_SENDER = "salon@hairsimo.it";
  process.env.GCP_PROJECT_ID = "hair-simo";
  isGcpConfigured.mockReturnValue(true);
  gmailSend.mockResolvedValue({ data: { id: "gmail-1" } });
  publishNotificationEvent.mockResolvedValue({ published: true, messageId: "pubsub-1" });
  enqueueTask.mockResolvedValue({ enqueued: true, taskName: "task-1" });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("silent delivery failure", () => {
  it("fails hard in production when no sender is configured and never sets sentAt", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.GCP_GMAIL_SENDER;
    const service = new NotificationService();

    await expect(service.sendAppointmentReminder(reminder)).rejects.toBeInstanceOf(
      NotificationTransportError,
    );

    expect(gmailSend).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      status: "failed",
      sentAt: null,
      attempts: 1,
      templateKey: REMINDER_TEMPLATE_KEY,
    });
    expect(db.rows[0]?.lastError).toContain("GMAIL_SENDER_NOT_CONFIGURED");
    await expect(service.wasReminderSent(reminder.appointmentId)).resolves.toBe(false);
  });

  it("rejects a bare send in production instead of pretending it was delivered", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.GCP_GMAIL_SENDER;

    await expect(
      new NotificationService().send({
        channel: "web",
        recipient: "info@hairsimo.it",
        message: "contact form",
      }),
    ).rejects.toThrow("GMAIL_SENDER_NOT_CONFIGURED");
  });

  it("records a send that was only logged as simulated, not as sent", async () => {
    delete process.env.GCP_GMAIL_SENDER;
    const service = new NotificationService();

    const { record, delivery } = await service.sendAppointmentReminder(reminder);

    expect(delivery.status).toBe("simulated");
    expect(gmailSend).not.toHaveBeenCalled();
    expect(record).toMatchObject({ status: "abandoned", sentAt: null, attempts: 1 });
    expect(record?.lastError).toBe("SIMULATED:GMAIL_SENDER_NOT_CONFIGURED");
    await expect(service.wasReminderSent(reminder.appointmentId)).resolves.toBe(false);
  });

  it("marks the row sent only after a real gmail call", async () => {
    const service = new NotificationService();

    const { record, delivery } = await service.sendAppointmentReminder(reminder);

    expect(delivery).toMatchObject({ status: "sent", provider: "gmail-api" });
    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(sentBody()).toContain(
      `Erinnerung: Ihr Termin bei Hair Simo ist morgen um ${reminder.timeLabel}.`,
    );
    expect(record).toMatchObject({ status: "sent", attempts: 1 });
    expect(record?.sentAt).toBeInstanceOf(Date);
    await expect(service.wasReminderSent(reminder.appointmentId)).resolves.toBe(true);
  });

  it("keeps a booking confirmation failure from breaking the booking", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.GCP_GMAIL_SENDER;

    const { record, delivery } = await new NotificationService().sendBookingConfirmation({
      appointmentId: "appointment-1",
      recipient: "guest@example.com",
      locale: "de",
      timeLabel: "Di., 4. Aug. 2026, 08:00-09:15",
    });

    expect(delivery.status).toBe("failed");
    expect(record).toMatchObject({ status: "failed", sentAt: null });
  });
});

describe("scheduled reminders", () => {
  it("schedules or sends, never both", async () => {
    const { record, delivery } = await new NotificationService().sendAppointmentReminder({
      ...reminder,
      scheduleDelaySeconds: 3600,
    });

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "notification.send",
        data: expect.objectContaining({ appointmentId: reminder.appointmentId }),
      }),
      3600,
    );
    expect(gmailSend).not.toHaveBeenCalled();
    expect(publishNotificationEvent).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({ status: "scheduled", taskName: "task-1" });
    expect(record).toMatchObject({ status: "pending", attempts: 0, sentAt: null });
  });

  it("does not silently swallow a queue that refuses the task", async () => {
    enqueueTask.mockResolvedValue({ enqueued: false });

    const { record, delivery } = await new NotificationService().sendAppointmentReminder({
      ...reminder,
      scheduleDelaySeconds: 3600,
    });

    expect(delivery.status).toBe("failed");
    expect(record).toMatchObject({ status: "failed", sentAt: null });
  });
});

describe("reminder idempotency", () => {
  it("sends once when the same reminder is requested twice", async () => {
    const service = new NotificationService();
    await service.sendAppointmentReminder(reminder);
    const second = await service.sendAppointmentReminder(reminder);

    expect(second.record).toBeNull();
    expect(second.delivery).toMatchObject({
      status: "skipped",
      reason: "REMINDER_ALREADY_HANDLED",
    });
    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
  });

  it("reports a blocked reminder to the batch pre-check in a single query", async () => {
    const service = new NotificationService();
    await service.sendAppointmentReminder(reminder);

    const blocked = await service.listAppointmentsWithBlockedReminder([
      "appointment-1",
      "appointment-2",
    ]);

    expect([...blocked]).toEqual(["appointment-1"]);
  });
});

describe("retry", () => {
  it("counts attempts on the row and abandons at the cap", async () => {
    gmailSend.mockRejectedValue(new Error("gmail down"));
    const service = new NotificationService();

    const first = await service.sendAppointmentReminder(reminder);
    expect(first.record).toMatchObject({ status: "failed", attempts: 1, sentAt: null });
    const notificationId = first.record?.id ?? "";

    const second = await service.retry(notificationId);
    expect(second.record).toMatchObject({ status: "failed", attempts: 2 });

    const third = await service.retry(notificationId);
    expect(third.record).toMatchObject({ status: "abandoned", attempts: MAX_DELIVERY_ATTEMPTS });

    const fourth = await service.retry(notificationId);
    expect(fourth.delivery).toMatchObject({ status: "skipped", reason: "ATTEMPTS_EXHAUSTED" });
    expect(gmailSend).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
  });

  it("resends the stored message in the stored locale", async () => {
    gmailSend.mockRejectedValueOnce(new Error("gmail down"));
    const service = new NotificationService();
    const first = await service.sendAppointmentReminder(reminder);

    const retried = await service.retry(first.record?.id ?? "");

    expect(retried.delivery.status).toBe("sent");
    expect(retried.record).toMatchObject({ status: "sent", attempts: 2, lastError: null });
    expect(retried.record?.sentAt).toBeInstanceOf(Date);
    expect(sentBody()).toContain(
      `Erinnerung: Ihr Termin bei Hair Simo ist morgen um ${reminder.timeLabel}.`,
    );
  });

  it("never resends something that was already delivered", async () => {
    const service = new NotificationService();
    const first = await service.sendAppointmentReminder(reminder);

    const retried = await service.retry(first.record?.id ?? "");

    expect(retried.delivery).toMatchObject({ status: "skipped", reason: "ALREADY_SENT" });
    expect(gmailSend).toHaveBeenCalledTimes(1);
  });

  it("refuses a row whose payload cannot be read", async () => {
    const service = new NotificationService();
    await service.sendAppointmentReminder(reminder);
    const row = db.rows[0];
    if (row) row.payload = { locale: "de" };

    await expect(service.retry(row?.id ?? "")).rejects.toThrow("NOTIFICATION_PAYLOAD_INVALID");
  });
});

describe("channels", () => {
  it("publishes an sms reminder and records the failure when the topic refuses it", async () => {
    publishNotificationEvent.mockResolvedValue({ published: false });
    const service = new NotificationService();

    const { record, delivery } = await service.sendAppointmentReminder({
      ...reminder,
      channel: "sms",
      recipient: "+390472268402",
    });

    expect(publishNotificationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms", type: "appointment.reminder", locale: "de" }),
    );
    expect(gmailSend).not.toHaveBeenCalled();
    expect(delivery.status).toBe("failed");
    expect(record).toMatchObject({ status: "failed", sentAt: null });
  });
});
