import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { db } = vi.hoisted(() => {
  const appointments: Row[] = [];
  const verifications: Row[] = [];
  const history: Row[] = [];
  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();

  // Anchored to the suite's NOW. A 1970 epoch made every `updatedAt <= now - cooldown`
  // comparison trivially true, so the resend cooldown could never be observed.
  function tick(): Date {
    sequence += 1;
    return new Date(Date.parse("2026-08-04T10:00:00.000Z") + sequence);
  }

  function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
  }

  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return comparable(actual) === expected.getTime();
    if (typeof expected === "object") {
      return Object.entries(expected as Row).every(([operator, operand]) => {
        const left = comparable(actual) as number;
        const right = comparable(operand) as number;
        if (operator === "lt") return left < right;
        if (operator === "lte") return left <= right;
        if (operator === "gt") return left > right;
        if (operator === "gte") return left >= right;
        if (operator === "not") return left !== right;
        if (operator === "in") return (operand as unknown[]).includes(actual);
        throw new Error(`unsupported operator ${operator}`);
      });
    }
    return actual === expected;
  }

  function matchesVerification(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === "appointment") {
        const linked = appointments.find((entry) => entry.id === row.appointmentId);
        return linked !== undefined && matchesAppointment(linked, expected as Row);
      }
      return matchValue(row[key], expected);
    });
  }

  function matchesAppointment(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === "OR") {
        return (expected as Row[]).some((clause) => matchesAppointment(row, clause));
      }
      if (key === "verification") {
        const linked = verifications.find((entry) => entry.appointmentId === row.id);
        const condition = (expected as { is: Row | null }).is;
        if (condition === null) return linked === undefined;
        return linked !== undefined && matchesVerification(linked, condition);
      }
      return matchValue(row[key], expected);
    });
  }

  function applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === "object" && "increment" in (value as Row)) {
        row[key] = ((row[key] as number) ?? 0) + ((value as { increment: number }).increment ?? 0);
        continue;
      }
      row[key] = value;
    }
    row.updatedAt = tick();
  }

  function sortAndTake(rows: Row[], args: Row): Row[] {
    const orderBy = args.orderBy as Row | undefined;
    const sorted = [...rows];
    if (orderBy) {
      const [key, direction] = Object.entries(orderBy)[0] as [string, string];
      sorted.sort((left, right) => {
        const a = comparable(left[key]) as number;
        const b = comparable(right[key]) as number;
        return direction === "desc" ? b - a : a - b;
      });
    }
    const take = args.take as number | undefined;
    return take === undefined ? sorted : sorted.slice(0, take);
  }

  const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });

  const bookingVerification = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (verifications.some((row) => row.appointmentId === data.appointmentId)) {
        throw uniqueViolation();
      }
      if (verifications.some((row) => row.tokenHash === data.tokenHash)) throw uniqueViolation();
      const stamp = tick();
      const row: Row = {
        id: `verification-${sequence}`,
        verifiedAt: null,
        sentCount: 0,
        createdAt: stamp,
        updatedAt: stamp,
        ...data,
      };
      verifications.push(row);
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const targets = verifications.filter((row) => matchesVerification(row, where));
      for (const row of targets) applyData(row, data);
      return { count: targets.length };
    }),
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const found = verifications.find((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      );
      return found ? { ...found } : null;
    }),
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        verifications.filter((row) => matchesVerification(row, args.where as Row)),
        args,
      ).map((row) => ({ ...row })),
    ),
  };

  const appointment = {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const found = appointments.find((row) => row.id === where.id);
      return found ? { ...found } : null;
    }),
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        appointments.filter((row) => matchesAppointment(row, args.where as Row)),
        args,
      ).map((row) => ({ ...row })),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const targets = appointments.filter((row) => matchesAppointment(row, where));
      for (const row of targets) applyData(row, data);
      return { count: targets.length };
    }),
    count: vi.fn(
      async (args: Row = {}) =>
        appointments.filter((row) => matchesAppointment(row, args.where as Row)).length,
    ),
  };

  const appointmentStatusHistory = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `history-${sequence}`, createdAt: tick(), ...data };
      history.push(row);
      return { ...row };
    }),
  };

  const delegates = { bookingVerification, appointment, appointmentStatusHistory };

  return {
    db: {
      ...delegates,
      appointments,
      verifications,
      history,
      // Read Committed on a single row behaves like this from the caller's side: the
      // conditional UPDATE of the loser runs after the winner committed and matches
      // nothing. Running the callbacks one at a time reproduces exactly that.
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
        const settled = queue.then(() => run(delegates));
        queue = settled.catch(() => undefined);
        return settled;
      }),
      reset() {
        appointments.length = 0;
        verifications.length = 0;
        history.length = 0;
        sequence = 0;
        queue = Promise.resolve();
      },
    },
  };
});

vi.mock("@hair-simo/db", () => ({
  prisma: {
    bookingVerification: db.bookingVerification,
    appointment: db.appointment,
    appointmentStatusHistory: db.appointmentStatusHistory,
    $transaction: db.$transaction,
  },
}));

import {
  MAX_CONCURRENT_UNVERIFIED_BOOKINGS,
  MAX_VERIFICATION_SENDS,
  MAX_VERIFICATION_WINDOW_MS,
  MIN_VERIFICATION_WINDOW_MS,
  PRE_APPOINTMENT_CUTOFF_MS,
  UNVERIFIED_CANCELLATION_REASON,
  VERIFICATION_INVALID,
  VERIFICATION_RESEND_COOLDOWN_MS,
  buildVerificationEmail,
  countUnverifiedBookings,
  createVerificationToken,
  expireUnverifiedBefore,
  hashVerificationToken,
  issueVerification,
  releaseOrphanedUnverified,
  verificationDeadline,
  verificationPath,
  verifyBookingToken,
} from "./booking-verification-service";

const NOW = new Date("2026-08-04T10:00:00.000Z");
const FAR = new Date("2026-08-25T08:00:00.000Z");
const TOMORROW = new Date("2026-08-05T07:00:00.000Z");

function seedAppointment(overrides: Row = {}): string {
  const id = (overrides.id as string) ?? `appointment-${db.appointments.length + 1}`;
  db.appointments.push({
    id,
    customerId: "customer-1",
    customer: { email: "guest@example.com" },
    status: "pending",
    startsAt: FAR,
    endsAt: new Date(FAR.getTime() + 45 * 60_000),
    locale: "de",
    sourceChannel: "web",
    depositRequired: false,
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  });
  return id;
}

function storedFor(appointmentId: string): Row {
  const row = db.verifications.find((entry) => entry.appointmentId === appointmentId);
  if (!row) throw new Error("no verification row");
  return row;
}

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
});

describe("token storage", () => {
  it("never puts the token itself into the database", async () => {
    const appointmentId = seedAppointment();
    const issued = await issueVerification(appointmentId, { now: NOW });

    const row = storedFor(appointmentId);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.tokenHash).toBe(createHash("sha256").update(issued.token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(Object.values(row)).not.toContain(issued.token);
  });

  it("draws a fresh token every time", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createVerificationToken()));
    expect(tokens.size).toBe(200);
  });

  it("builds a locale-prefixed landing path", async () => {
    expect(verificationPath("abc-token", "it")).toBe("/it/booking/verify/abc-token");
    expect(verificationPath("abc-token", "es")).toBe("/de/booking/verify/abc-token");
  });
});

describe("verification deadline", () => {
  it("gives a distant appointment the full window", () => {
    expect(verificationDeadline(NOW, FAR).getTime()).toBe(NOW.getTime() + MAX_VERIFICATION_WINDOW_MS);
  });

  it("stops short of an appointment that is already tomorrow morning", () => {
    const deadline = verificationDeadline(NOW, TOMORROW);
    expect(deadline.getTime()).toBe(TOMORROW.getTime() - PRE_APPOINTMENT_CUTOFF_MS);
    expect(deadline.getTime()).toBeLessThan(NOW.getTime() + MAX_VERIFICATION_WINDOW_MS);
    expect(deadline.getTime()).toBeLessThan(TOMORROW.getTime());
  });

  it("still leaves a floor for a booking taken just past the lead time", () => {
    const soon = new Date(NOW.getTime() + 130 * 60_000);
    expect(verificationDeadline(NOW, soon).getTime()).toBe(
      NOW.getTime() + MIN_VERIFICATION_WINDOW_MS,
    );
  });

  it("persists the near deadline rather than a fixed day", async () => {
    const far = seedAppointment({ id: "far" });
    const near = seedAppointment({ id: "near", startsAt: TOMORROW });

    const issuedFar = await issueVerification(far, { now: NOW });
    const issuedNear = await issueVerification(near, { now: NOW });

    expect(issuedFar.expiresAt.getTime()).toBe(NOW.getTime() + MAX_VERIFICATION_WINDOW_MS);
    expect(issuedNear.expiresAt.getTime()).toBe(TOMORROW.getTime() - PRE_APPOINTMENT_CUTOFF_MS);
  });
});

describe("issuing", () => {
  it("returns everything the mail needs", async () => {
    const appointmentId = seedAppointment();
    const issued = await issueVerification(appointmentId, { now: NOW });
    expect(issued).toMatchObject({
      appointmentId,
      sentCount: 1,
      locale: "de",
      recipient: "guest@example.com",
    });
  });

  it("refuses an appointment that is not pending", async () => {
    const appointmentId = seedAppointment({ status: "confirmed" });
    await expect(issueVerification(appointmentId, { now: NOW })).rejects.toThrow(
      "APPOINTMENT_NOT_PENDING",
    );
  });

  it("refuses a customer without an e-mail address", async () => {
    const appointmentId = seedAppointment({ customer: { email: null } });
    await expect(issueVerification(appointmentId, { now: NOW })).rejects.toThrow(
      "CUSTOMER_EMAIL_MISSING",
    );
  });

  it("refuses an unknown appointment", async () => {
    await expect(issueVerification("nope", { now: NOW })).rejects.toThrow("APPOINTMENT_NOT_FOUND");
  });
});

describe("resend cap", () => {
  function later(sends: number): Date {
    return new Date(NOW.getTime() + sends * (VERIFICATION_RESEND_COOLDOWN_MS + 1_000));
  }

  it("stops after the cap and rotates the token on every resend", async () => {
    const appointmentId = seedAppointment();
    const tokens: string[] = [];
    for (let send = 0; send < MAX_VERIFICATION_SENDS; send += 1) {
      const issued = await issueVerification(appointmentId, { now: later(send) });
      expect(issued.sentCount).toBe(send + 1);
      tokens.push(issued.token);
    }

    expect(new Set(tokens).size).toBe(MAX_VERIFICATION_SENDS);
    expect(storedFor(appointmentId).tokenHash).toBe(hashVerificationToken(tokens.at(-1) as string));

    await expect(
      issueVerification(appointmentId, { now: later(MAX_VERIFICATION_SENDS) }),
    ).rejects.toThrow("VERIFICATION_RESEND_LIMIT");
    expect(storedFor(appointmentId).sentCount).toBe(MAX_VERIFICATION_SENDS);
  });

  it("holds a second send back until the cooldown has passed", async () => {
    const appointmentId = seedAppointment();
    await issueVerification(appointmentId, { now: NOW });
    await expect(
      issueVerification(appointmentId, { now: new Date(NOW.getTime() + 5_000) }),
    ).rejects.toThrow("VERIFICATION_RESEND_TOO_SOON");
    expect(storedFor(appointmentId).sentCount).toBe(1);
  });

  it("invalidates the previous link when a new one is issued", async () => {
    const appointmentId = seedAppointment();
    const first = await issueVerification(appointmentId, { now: NOW });
    await issueVerification(appointmentId, { now: later(1) });

    await expect(verifyBookingToken(first.token, later(1))).rejects.toThrow(VERIFICATION_INVALID);
  });
});

describe("per-customer hold cap", () => {
  it("counts only future pending bookings that are still unverified", async () => {
    for (let index = 0; index < MAX_CONCURRENT_UNVERIFIED_BOOKINGS; index += 1) {
      const id = seedAppointment({ id: `held-${index}` });
      await issueVerification(id, { now: NOW, enforceCustomerCap: false });
    }
    expect(await countUnverifiedBookings("customer-1", { now: NOW })).toBe(
      MAX_CONCURRENT_UNVERIFIED_BOOKINGS,
    );

    const extra = seedAppointment({ id: "extra" });
    await expect(issueVerification(extra, { now: NOW })).rejects.toThrow(
      "UNVERIFIED_BOOKING_LIMIT",
    );
  });

  it("does not count a booking the same customer already verified", async () => {
    const id = seedAppointment({ id: "verified-one" });
    const issued = await issueVerification(id, { now: NOW });
    await verifyBookingToken(issued.token, NOW);
    expect(await countUnverifiedBookings("customer-1", { now: NOW })).toBe(0);
  });
});

describe("verifying", () => {
  it("confirms the appointment and writes one history row", async () => {
    const appointmentId = seedAppointment();
    const issued = await issueVerification(appointmentId, { now: NOW });

    await expect(verifyBookingToken(issued.token, NOW)).resolves.toEqual({
      appointmentId,
      alreadyVerified: false,
    });
    expect(db.appointments[0].status).toBe("confirmed");
    expect(storedFor(appointmentId).verifiedAt).toEqual(NOW);
    expect(db.history).toHaveLength(1);
    expect(db.history[0]).toMatchObject({ status: "confirmed", reason: "email verified" });
  });

  it("stays idempotent when the customer double-clicks the link", async () => {
    const appointmentId = seedAppointment();
    const issued = await issueVerification(appointmentId, { now: NOW });

    const [first, second] = await Promise.all([
      verifyBookingToken(issued.token, NOW),
      verifyBookingToken(issued.token, NOW),
    ]);

    expect([first.alreadyVerified, second.alreadyVerified].sort()).toEqual([false, true]);
    expect(first.appointmentId).toBe(appointmentId);
    expect(second.appointmentId).toBe(appointmentId);
    expect(db.history).toHaveLength(1);
    expect(db.appointments[0].status).toBe("confirmed");
  });

  it("reports the same error for unknown, malformed and expired tokens", async () => {
    const appointmentId = seedAppointment({ startsAt: TOMORROW });
    const issued = await issueVerification(appointmentId, { now: NOW });
    const afterDeadline = new Date(issued.expiresAt.getTime() + 1);

    await expect(verifyBookingToken(issued.token, afterDeadline)).rejects.toThrow(
      VERIFICATION_INVALID,
    );
    await expect(verifyBookingToken(createVerificationToken(), NOW)).rejects.toThrow(
      VERIFICATION_INVALID,
    );
    await expect(verifyBookingToken("", NOW)).rejects.toThrow(VERIFICATION_INVALID);
    expect(db.appointments[0].status).toBe("pending");
  });

  it("does not resurrect a cancelled appointment", async () => {
    const appointmentId = seedAppointment();
    const issued = await issueVerification(appointmentId, { now: NOW });
    db.appointments[0].status = "cancelled";

    await expect(verifyBookingToken(issued.token, NOW)).rejects.toThrow(
      "BOOKING_VERIFICATION_APPOINTMENT_CANCELLED",
    );
    expect(db.appointments[0].status).toBe("cancelled");
    expect(db.history).toHaveLength(0);
  });
});

describe("expiring unverified bookings", () => {
  it("releases only the slots whose own deadline has passed", async () => {
    const near = seedAppointment({ id: "near", startsAt: TOMORROW });
    const far = seedAppointment({ id: "far" });
    await issueVerification(near, { now: NOW });
    await issueVerification(far, { now: NOW });

    const sweep = new Date(TOMORROW.getTime() - PRE_APPOINTMENT_CUTOFF_MS + 1_000);
    await expect(expireUnverifiedBefore(sweep)).resolves.toBe(1);

    const nearRow = db.appointments.find((row) => row.id === "near") as Row;
    const farRow = db.appointments.find((row) => row.id === "far") as Row;
    expect(nearRow.status).toBe("cancelled");
    expect(nearRow.cancellationReason).toBe(UNVERIFIED_CANCELLATION_REASON);
    expect(farRow.status).toBe("pending");
  });

  it("counts a slot once even when two cron runs overlap", async () => {
    const appointmentId = seedAppointment({ startsAt: TOMORROW });
    await issueVerification(appointmentId, { now: NOW });
    const sweep = new Date(TOMORROW.getTime());

    const [first, second] = await Promise.all([
      expireUnverifiedBefore(sweep),
      expireUnverifiedBefore(sweep),
    ]);

    expect(first + second).toBe(1);
    expect(db.history).toHaveLength(1);
    await expect(expireUnverifiedBefore(sweep)).resolves.toBe(0);
  });

  it("leaves a verified booking alone forever", async () => {
    const appointmentId = seedAppointment({ startsAt: TOMORROW });
    const issued = await issueVerification(appointmentId, { now: NOW });
    await verifyBookingToken(issued.token, NOW);

    await expect(expireUnverifiedBefore(new Date(TOMORROW.getTime()))).resolves.toBe(0);
    expect(db.appointments[0].status).toBe("confirmed");
  });
});

describe("orphaned bookings", () => {
  it("releases a web booking that never got a verification row", async () => {
    seedAppointment({
      id: "orphan",
      createdAt: new Date(NOW.getTime() - MAX_VERIFICATION_WINDOW_MS - 60_000),
    });
    await expect(releaseOrphanedUnverified(NOW)).resolves.toBe(1);
    expect(db.appointments[0].status).toBe("cancelled");
  });

  it("releases an orphan whose slot is about to start", async () => {
    seedAppointment({
      id: "imminent",
      startsAt: new Date(NOW.getTime() + 60 * 60_000),
      createdAt: new Date(NOW.getTime() - 30 * 60_000),
    });
    await expect(releaseOrphanedUnverified(NOW)).resolves.toBe(1);
  });

  it("keeps a booking that was created seconds ago", async () => {
    seedAppointment({
      id: "fresh",
      startsAt: new Date(NOW.getTime() + 3 * 60 * 60_000),
      createdAt: new Date(NOW.getTime() - 10_000),
    });
    await expect(releaseOrphanedUnverified(NOW)).resolves.toBe(0);
  });

  it("keeps deposit bookings and phone bookings out of the sweep", async () => {
    const old = new Date(NOW.getTime() - MAX_VERIFICATION_WINDOW_MS - 60_000);
    seedAppointment({ id: "deposit", depositRequired: true, createdAt: old });
    seedAppointment({ id: "whatsapp", sourceChannel: "whatsapp", createdAt: old });
    await expect(releaseOrphanedUnverified(NOW)).resolves.toBe(0);
  });

  it("ignores an appointment that already has a link out", async () => {
    const appointmentId = seedAppointment({
      id: "linked",
      createdAt: new Date(NOW.getTime() - MAX_VERIFICATION_WINDOW_MS - 60_000),
    });
    await issueVerification(appointmentId, { now: NOW });
    await expect(releaseOrphanedUnverified(NOW)).resolves.toBe(0);
  });
});

describe("verification e-mail", () => {
  const email = (locale: string) =>
    buildVerificationEmail({
      locale,
      verifyUrl: "https://hairsimo.it/de/booking/verify/tok",
      startsAt: FAR,
      endsAt: new Date(FAR.getTime() + 45 * 60_000),
      expiresAt: new Date(NOW.getTime() + MAX_VERIFICATION_WINDOW_MS),
    });

  it("renders a distinct subject and body per salon locale", () => {
    const subjects = new Set(["de", "it", "fr", "en"].map((locale) => email(locale).subject));
    expect(subjects.size).toBe(4);
    for (const locale of ["de", "it", "fr", "en"]) {
      const rendered = email(locale);
      expect(rendered.locale).toBe(locale);
      expect(rendered.message).toContain("https://hairsimo.it/de/booking/verify/tok");
      expect(rendered.message.length).toBeGreaterThan(60);
    }
  });

  it("renders times in the salon zone, not the host zone", () => {
    expect(email("de").message).toContain("10:00");
  });
});
