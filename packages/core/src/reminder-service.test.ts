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

const {
  db,
  gmailSend,
  isGcpConfigured,
  publishNotificationEvent,
  enqueueTask,
  listUpcomingForReminders,
} = vi.hoisted(() => {
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
    listUpcomingForReminders: vi.fn(),
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

vi.mock("./booking-service", () => ({
  BookingService: class {
    listUpcomingForReminders = listUpcomingForReminders;
  },
}));

import { ReminderService } from "./reminder-service";

const originalEnv = { ...process.env };

type ReminderAppointment = {
  id: string;
  locale: string;
  startsAt: Date;
  endsAt: Date;
  customer: {
    email: string | null;
    phone: string | null;
    deletedAt: Date | null;
    anonymizedAt: Date | null;
  };
};

function appointment(overrides: Partial<ReminderAppointment> = {}): ReminderAppointment {
  return {
    id: "appointment-1",
    locale: "de",
    startsAt: new Date("2026-08-04T06:00:00.000Z"),
    endsAt: new Date("2026-08-04T07:15:00.000Z"),
    customer: { email: "guest@example.com", phone: null, deletedAt: null, anonymizedAt: null },
    ...overrides,
  };
}

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
  listUpcomingForReminders.mockResolvedValue([appointment()]);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("reminder wording", () => {
  it("renders the appointment in the salon zone whatever the host zone is", async () => {
    for (const hostZone of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
      process.env.TZ = hostZone;
      db.reset();
      gmailSend.mockClear();

      await new ReminderService().dispatchDueReminders();

      const body = sentBody();
      expect(body).toContain("Di., 4. Aug. 2026, 08:00-09:15");
      expect(body).not.toContain("06:00");
    }
  });

  it("uses the appointment locale", async () => {
    listUpcomingForReminders.mockResolvedValue([appointment({ locale: "it" })]);

    await new ReminderService().dispatchDueReminders();

    expect(sentBody()).toContain("Promemoria: il tuo appuntamento da Hair Simo");
    expect(sentBody()).toContain("mar 4 ago 2026, 08:00-09:15");
  });
});

describe("batch correctness", () => {
  it("checks the whole batch with one query instead of one per appointment", async () => {
    listUpcomingForReminders.mockResolvedValue([
      appointment({ id: "appointment-1" }),
      appointment({ id: "appointment-2" }),
      appointment({ id: "appointment-3" }),
    ]);

    const result = await new ReminderService().dispatchDueReminders();

    const batchQueries = db.notificationLog.findMany.mock.calls.filter(([args]) => {
      const appointmentId = args?.where?.appointmentId;
      return typeof appointmentId === "object" && appointmentId !== null;
    });
    expect(batchQueries).toHaveLength(1);
    expect(db.notificationLog.findFirst).not.toHaveBeenCalled();
    expect(result.sent).toBe(3);
    expect(gmailSend).toHaveBeenCalledTimes(3);
  });

  it("produces exactly one notification when two cron runs overlap", async () => {
    const service = new ReminderService();

    const [first, second] = await Promise.all([
      service.dispatchDueReminders(),
      service.dispatchDueReminders(),
    ]);

    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect([first.sent, second.sent].sort()).toEqual([0, 1]);
    expect([first.skipped, second.skipped].sort()).toEqual([0, 1]);
  });

  it("skips an appointment that was already reminded", async () => {
    const service = new ReminderService();
    await service.dispatchDueReminders();
    gmailSend.mockClear();

    const result = await service.dispatchDueReminders();

    expect(gmailSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 1, sent: 0, skipped: 1 });
    expect(db.rows).toHaveLength(1);
  });
});

describe("recipient resolution", () => {
  it("falls back to sms when the customer has no email", async () => {
    listUpcomingForReminders.mockResolvedValue([
      appointment({
        customer: {
          email: null,
          phone: "+390472268402",
          deletedAt: null,
          anonymizedAt: null,
        },
      }),
    ]);

    const result = await new ReminderService().dispatchDueReminders();

    expect(gmailSend).not.toHaveBeenCalled();
    expect(publishNotificationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms", recipient: "+390472268402" }),
    );
    expect(result.sent).toBe(1);
    expect(db.rows[0]).toMatchObject({ channel: "sms", status: "sent" });
  });

  it("skips a customer without any contact detail without throwing", async () => {
    listUpcomingForReminders.mockResolvedValue([
      appointment({
        customer: { email: null, phone: "   ", deletedAt: null, anonymizedAt: null },
      }),
    ]);

    const result = await new ReminderService().dispatchDueReminders();

    expect(result).toMatchObject({ processed: 1, sent: 0, unreachable: 1 });
    expect(db.rows).toHaveLength(0);
    expect(gmailSend).not.toHaveBeenCalled();
    expect(publishNotificationEvent).not.toHaveBeenCalled();
  });

  it("never writes to an erased customer", async () => {
    listUpcomingForReminders.mockResolvedValue([
      appointment({
        customer: {
          email: "guest@example.com",
          phone: null,
          deletedAt: new Date("2026-07-01T00:00:00.000Z"),
          anonymizedAt: null,
        },
      }),
    ]);

    const result = await new ReminderService().dispatchDueReminders();

    expect(result.unreachable).toBe(1);
    expect(gmailSend).not.toHaveBeenCalled();
  });
});

describe("window", () => {
  it("falls back to 24 hours when the caller passes garbage", async () => {
    await new ReminderService().dispatchDueReminders(Number.NaN);
    expect(listUpcomingForReminders).toHaveBeenCalledWith(24);

    await new ReminderService().dispatchDueReminders(24 * 365);
    expect(listUpcomingForReminders).toHaveBeenLastCalledWith(24 * 7);
  });
});
