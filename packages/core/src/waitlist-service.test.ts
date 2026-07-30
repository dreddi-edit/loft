import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type IdentifiedRow = Row & { id: string };
type Relations = Record<string, (row: Row) => Row | null>;

const { db, notificationSend } = vi.hoisted(() => {
  // Anchored to the suite's NOW. A 1970 epoch would make every "notifiedAt <= now -
  // cooldown" comparison trivially true and no cooldown could ever be observed.
  const ANCHOR_MS = Date.parse("2026-08-04T08:00:00.000Z");

  const waitlists: Row[] = [];
  const customers: Row[] = [];
  const services: Row[] = [];
  const staffProfiles: Row[] = [];
  const staffServices: Row[] = [];
  const appointments: Row[] = [];
  const statusHistory: Row[] = [];

  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let transactions = 0;
  let transactionHook: ((attempt: number) => void) | null = null;

  function tick(): Date {
    sequence += 1;
    return new Date(ANCHOR_MS + sequence);
  }

  function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
  }

  function operatorMatch(actual: unknown, operator: string, operand: unknown): boolean {
    if (operator === "in") {
      return (operand as unknown[]).some((item) => comparable(item) === comparable(actual));
    }
    if (operator === "notIn") {
      return !(operand as unknown[]).some((item) => comparable(item) === comparable(actual));
    }
    if (operator === "not") {
      if (operand === null) return actual !== null && actual !== undefined;
      return comparable(actual) !== comparable(operand);
    }
    const left = comparable(actual) as number;
    const right = comparable(operand) as number;
    if (operator === "lt") return left < right;
    if (operator === "lte") return left <= right;
    if (operator === "gt") return left > right;
    if (operator === "gte") return left >= right;
    throw new Error(`unsupported operator ${operator}`);
  }

  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return comparable(actual) === expected.getTime();
    if (typeof expected === "object") {
      return Object.entries(expected as Row).every(([operator, operand]) =>
        operatorMatch(actual, operator, operand),
      );
    }
    return actual === expected;
  }

  function matchRow(row: Row, where?: Row, relations: Relations = {}): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      if (key === "OR") return (expected as Row[]).some((one) => matchRow(row, one, relations));
      if (key === "AND") return (expected as Row[]).every((one) => matchRow(row, one, relations));
      if (key === "NOT") return !matchRow(row, expected as Row, relations);
      const relation = relations[key];
      if (relation) {
        const linked = relation(row);
        return linked !== null && matchRow(linked, expected as Row);
      }
      return matchValue(row[key], expected);
    });
  }

  function sortRows(rows: Row[], orderBy: unknown): Row[] {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    const keys = clauses.flatMap((clause) => Object.entries(clause as Row)) as [string, string][];
    if (keys.length === 0) return [...rows];
    return [...rows].sort((left, right) => {
      for (const [key, direction] of keys) {
        const a = comparable(left[key]) as number;
        const b = comparable(right[key]) as number;
        if (a === b) continue;
        return direction === "desc" ? (a < b ? 1 : -1) : a < b ? -1 : 1;
      }
      return 0;
    });
  }

  function applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) row[key] = value;
    row.updatedAt = tick();
  }

  const waitlistRelations: Relations = {
    customer: (row) => customers.find((entry) => entry.id === row.customerId) ?? null,
  };

  function hydrateWaitlist(row: Row, include?: Row): Row {
    const copy = { ...row };
    if (!include) return copy;
    if (include.customer) {
      const found = customers.find((entry) => entry.id === row.customerId);
      copy.customer = found
        ? {
            id: found.id,
            firstName: found.firstName,
            lastName: found.lastName,
            email: found.email,
            phone: found.phone,
            locale: found.locale,
          }
        : null;
    }
    if (include.service) {
      const found = services.find((entry) => entry.id === row.serviceId);
      copy.service = found
        ? {
            id: found.id,
            slug: found.slug,
            durationMin: found.durationMin,
            bufferAfterMin: found.bufferAfterMin,
            translations: found.translations,
          }
        : null;
    }
    if (include.staff) {
      const found = staffProfiles.find((entry) => entry.id === row.staffId);
      copy.staff = found ? { id: found.id, displayName: found.displayName } : null;
    }
    return copy;
  }

  function hydrateAppointment(row: Row, include?: Row): Row {
    const copy = { ...row };
    if (include?.service) {
      const found = services.find((entry) => entry.id === row.serviceId);
      copy.service = { bufferAfterMin: found ? found.bufferAfterMin : 0 };
    }
    return copy;
  }

  const waitlist = {
    findMany: vi.fn(async (args: Row = {}) =>
      sortRows(
        waitlists.filter((row) => matchRow(row, args.where as Row, waitlistRelations)),
        args.orderBy,
      )
        .slice(0, args.take as number | undefined)
        .map((row) => hydrateWaitlist(row, args.include as Row | undefined)),
    ),
    findUnique: vi.fn(async (args: Row) => {
      const found = waitlists.find((row) => row.id === (args.where as Row).id);
      return found ? hydrateWaitlist(found, args.include as Row | undefined) : null;
    }),
    create: vi.fn(async (args: Row) => {
      const stamp = tick();
      const row: Row = {
        id: `waitlist-${sequence}`,
        staffId: null,
        locale: "en",
        channel: "web",
        status: "active",
        notifiedAt: null,
        convertedAppointmentId: null,
        createdAt: stamp,
        updatedAt: stamp,
        ...(args.data as Row),
      };
      waitlists.push(row);
      return { ...row };
    }),
    update: vi.fn(async (args: Row) => {
      const row = waitlists.find((entry) => entry.id === (args.where as Row).id);
      if (!row) throw Object.assign(new Error("RECORD_NOT_FOUND"), { code: "P2025" });
      applyData(row, args.data as Row);
      return { ...row };
    }),
    updateMany: vi.fn(async (args: Row) => {
      const targets = waitlists.filter((row) =>
        matchRow(row, args.where as Row, waitlistRelations),
      );
      for (const row of targets) applyData(row, args.data as Row);
      return { count: targets.length };
    }),
  };

  const customer = {
    findUnique: vi.fn(async (args: Row) => {
      const found = customers.find((row) => row.id === (args.where as Row).id);
      return found ? { ...found } : null;
    }),
  };

  const service = {
    findUnique: vi.fn(async (args: Row) => {
      const found = services.find((row) => row.id === (args.where as Row).id);
      return found ? { ...found } : null;
    }),
    aggregate: vi.fn(async () => ({
      _max: {
        durationMin: services.length
          ? Math.max(...services.map((row) => row.durationMin as number))
          : null,
        bufferAfterMin: services.length
          ? Math.max(...services.map((row) => row.bufferAfterMin as number))
          : null,
      },
    })),
  };

  const staffProfile = {
    findUnique: vi.fn(async (args: Row) => {
      const found = staffProfiles.find((row) => row.id === (args.where as Row).id);
      if (!found) return null;
      const select = args.select as Row | undefined;
      const linkWhere = (select?.staffServices as Row | undefined)?.where as Row | undefined;
      return {
        ...found,
        staffServices: staffServices
          .filter((link) => link.staffId === found.id && matchRow(link, linkWhere))
          .map((link) => ({ id: link.id })),
      };
    }),
  };

  const appointment = {
    findMany: vi.fn(async (args: Row = {}) =>
      sortRows(
        appointments.filter((row) => matchRow(row, args.where as Row)),
        args.orderBy,
      ).map((row) => hydrateAppointment(row, args.include as Row | undefined)),
    ),
    findUnique: vi.fn(async (args: Row) => {
      const found = appointments.find((row) => row.id === (args.where as Row).id);
      return found ? { ...found } : null;
    }),
    create: vi.fn(async (args: Row) => {
      const data = { ...(args.data as Row) };
      const nested = data.statusHistory as { create?: Row } | undefined;
      delete data.statusHistory;
      const stamp = tick();
      const row: Row = {
        id: `appointment-${appointments.length + 1}`,
        status: "pending",
        createdAt: stamp,
        updatedAt: stamp,
        ...data,
      };
      appointments.push(row);
      if (nested?.create) {
        statusHistory.push({
          id: `history-${statusHistory.length + 1}`,
          appointmentId: row.id,
          createdAt: tick(),
          ...nested.create,
        });
      }
      return { ...row };
    }),
  };

  const delegates = { waitlist, customer, service, staffProfile, appointment };

  const prisma = {
    ...delegates,
    // Serializable on Postgres presents itself to the caller like this: the second
    // transaction only observes what the first one committed. Draining the callbacks
    // through one queue reproduces exactly that, and the two callers still interleave
    // freely on every await outside the transaction.
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const settled = queue.then(async () => {
        transactions += 1;
        transactionHook?.(transactions);
        return run(delegates);
      });
      queue = settled.catch(() => undefined);
      return settled;
    }),
  };

  return {
    notificationSend: vi.fn(),
    db: {
      prisma,
      waitlists,
      customers,
      services,
      staffProfiles,
      staffServices,
      appointments,
      statusHistory,
      anchorMs: ANCHOR_MS,
      transactionCount: () => transactions,
      onTransaction(hook: ((attempt: number) => void) | null) {
        transactionHook = hook;
      },
      reset() {
        waitlists.length = 0;
        customers.length = 0;
        services.length = 0;
        staffProfiles.length = 0;
        staffServices.length = 0;
        appointments.length = 0;
        statusHistory.length = 0;
        sequence = 0;
        transactions = 0;
        transactionHook = null;
        queue = Promise.resolve();
      },
    },
  };
});

vi.mock("@hair-simo/db", () => ({

  DEFAULT_TENANT_ID: "cltenant00000000000000001",
  DEFAULT_TENANT_SLUG: "hairsimo-brixen",
  currentTenantId: () => "cltenant00000000000000001",
  tenantEmailKey: (email: string) => ({ tenantId_email: { tenantId: "cltenant00000000000000001", email } }),
  tenantPhoneKey: (phone: string) => ({ tenantId_phone: { tenantId: "cltenant00000000000000001", phone } }),
  tenantSlugKey: (slug: string) => ({ tenantId_slug: { tenantId: "cltenant00000000000000001", slug } }),
  tenantSkuKey: (sku: string) => ({ tenantId_sku: { tenantId: "cltenant00000000000000001", sku } }),
  tenantCodeKey: (code: string) => ({ tenantId_code: { tenantId: "cltenant00000000000000001", code } }),
  tenantDayOfWeekKey: (dayOfWeek: number) => ({ tenantId_dayOfWeek: { tenantId: "cltenant00000000000000001", dayOfWeek } }),
  getTenantContext: () => undefined,
  forEachActiveTenant: async (work: (ctx: { tenantId: string; slug: string }) => Promise<void>) => {
    await work({ tenantId: "cltenant00000000000000001", slug: "hairsimo-brixen" });
    return { tenantCount: 1 };
  },
 prisma: db.prisma }));

vi.mock("./notification-service", () => ({
  NotificationService: vi.fn(() => ({ send: notificationSend })),
}));

import {
  DEFAULT_MIN_OFFER_LEAD_MINUTES,
  DEFAULT_OFFERS_PER_SLOT,
  DEFAULT_OFFER_COOLDOWN_MINUTES,
  DEFAULT_OFFER_TTL_MINUTES,
  MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER,
  MAX_WAITLIST_WINDOW_DAYS,
  WAITLIST_HORIZON_DAYS,
  WaitlistError,
  WaitlistService,
  createWaitlistOfferToken,
  minOfferLeadMinutes,
  offerCooldownMinutes,
  offerExpiresAt,
  offerTtlMinutes,
  readWaitlistOfferToken,
} from "./waitlist-service";
import type { FreedSlot, WaitlistMatch } from "./waitlist-service";

const NOW = new Date("2026-08-04T08:00:00.000Z");
const SLOT_START = new Date("2026-08-04T12:00:00.000Z");
const SLOT_END = new Date("2026-08-04T13:00:00.000Z");
const WINDOW_FROM = new Date("2026-08-04T07:00:00.000Z");
const WINDOW_TO = new Date("2026-08-04T16:00:00.000Z");

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TTL_MS = DEFAULT_OFFER_TTL_MINUTES * MINUTE;
const COOLDOWN_MS = DEFAULT_OFFER_COOLDOWN_MINUTES * MINUTE;

const SLOT: FreedSlot = { serviceId: "service-cut", staffId: "staff-1", startsAt: SLOT_START };

const originalEnv = { ...process.env };
let entrySequence = 0;

function translations(name: string) {
  return [
    { locale: "de", name: `${name} DE` },
    { locale: "it", name: `${name} IT` },
    { locale: "fr", name: `${name} FR` },
    { locale: "en", name: `${name} EN` },
  ];
}

function seedBaseData(): void {
  db.services.push(
    {
      id: "service-cut",
      slug: "cut",
      durationMin: 60,
      bufferAfterMin: 0,
      isActive: true,
      translations: translations("Haircut"),
    },
    {
      id: "service-color",
      slug: "color",
      durationMin: 90,
      bufferAfterMin: 15,
      isActive: true,
      translations: translations("Colour"),
    },
    {
      id: "service-retired",
      slug: "retired",
      durationMin: 30,
      bufferAfterMin: 0,
      isActive: false,
      translations: translations("Retired"),
    },
  );

  db.staffProfiles.push(
    { id: "staff-1", displayName: "Simona", isBookable: true },
    { id: "staff-2", displayName: "Marco", isBookable: true },
    { id: "staff-3", displayName: "Ex-Employee", isBookable: false },
    { id: "staff-4", displayName: "Colourist", isBookable: true },
  );

  db.staffServices.push(
    { id: "link-1", staffId: "staff-1", serviceId: "service-cut" },
    { id: "link-2", staffId: "staff-1", serviceId: "service-color" },
    { id: "link-3", staffId: "staff-2", serviceId: "service-cut" },
    { id: "link-4", staffId: "staff-3", serviceId: "service-cut" },
    { id: "link-5", staffId: "staff-4", serviceId: "service-color" },
  );

  db.customers.push(
    {
      id: "customer-1",
      firstName: "Anna",
      lastName: "Rossi",
      email: "anna@example.com",
      phone: "+390471000001",
      locale: "de",
      deletedAt: null,
      anonymizedAt: null,
    },
    {
      id: "customer-2",
      firstName: "Luca",
      lastName: "Bianchi",
      email: "luca@example.com",
      phone: null,
      locale: "it",
      deletedAt: null,
      anonymizedAt: null,
    },
    {
      id: "customer-3",
      firstName: "Camille",
      lastName: "Dubois",
      email: null,
      phone: "+390471000003",
      locale: "fr",
      deletedAt: null,
      anonymizedAt: null,
    },
    {
      id: "customer-4",
      firstName: "Ghost",
      lastName: "Nocontact",
      email: null,
      phone: null,
      locale: "en",
      deletedAt: null,
      anonymizedAt: null,
    },
    {
      id: "customer-erased",
      firstName: "Erased",
      lastName: "Person",
      email: "erased@example.com",
      phone: null,
      locale: "de",
      deletedAt: new Date(NOW.getTime() - DAY),
      anonymizedAt: null,
    },
    {
      id: "customer-anonymous",
      firstName: "Anon",
      lastName: "Person",
      email: "anon@example.com",
      phone: null,
      locale: "de",
      deletedAt: null,
      anonymizedAt: new Date(NOW.getTime() - DAY),
    },
  );
}

function seedEntry(overrides: Row = {}): IdentifiedRow {
  entrySequence += 1;
  const created = new Date(NOW.getTime() - HOUR + entrySequence * 1_000);
  const row: IdentifiedRow = {
    id: `entry-${entrySequence}`,
    customerId: "customer-1",
    serviceId: "service-cut",
    staffId: null,
    earliestAt: WINDOW_FROM,
    latestAt: WINDOW_TO,
    locale: "de",
    channel: "web",
    status: "active",
    notifiedAt: null,
    convertedAppointmentId: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
  db.waitlists.push(row);
  return row;
}

function seedAppointment(overrides: Row = {}): IdentifiedRow {
  const row: IdentifiedRow = {
    id: `seeded-appointment-${db.appointments.length + 1}`,
    customerId: "customer-1",
    serviceId: "service-cut",
    staffId: "staff-1",
    startsAt: SLOT_START,
    endsAt: SLOT_END,
    status: "confirmed",
    locale: "de",
    sourceChannel: "web",
    createdAt: new Date(NOW.getTime() - DAY),
    updatedAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
  db.appointments.push(row);
  return row;
}

function storedEntry(id: string): Row {
  const row = db.waitlists.find((entry) => entry.id === id);
  if (!row) throw new Error(`no waitlist row ${id}`);
  return row;
}

function joinInput(overrides: Row = {}): Row {
  return {
    customerId: "customer-1",
    serviceId: "service-cut",
    earliestAt: WINDOW_FROM,
    latestAt: WINDOW_TO,
    ...overrides,
  };
}

function service(): WaitlistService {
  return new WaitlistService();
}

beforeEach(() => {
  db.reset();
  entrySequence = 0;
  vi.clearAllMocks();
  notificationSend.mockResolvedValue({ status: "sent", provider: "test" });
  seedBaseData();

  process.env.WAITLIST_OFFER_SECRET = "waitlist-offer-secret-for-tests";
  delete process.env.WAITLIST_OFFER_TTL_MINUTES;
  delete process.env.WAITLIST_OFFER_COOLDOWN_MINUTES;
  delete process.env.WAITLIST_MIN_LEAD_MINUTES;
  delete process.env.WAITLIST_CLAIM_BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("test harness", () => {
  it("anchors the fake clock to the suite's NOW", () => {
    expect(db.anchorMs).toBe(NOW.getTime());
  });
});

describe("offer tokens", () => {
  const claims = {
    entryId: "entry-1",
    staffId: "staff-1",
    slotStartsAt: SLOT_START,
    notifiedAtMs: NOW.getTime(),
  };

  it("round-trips every claim it carries", () => {
    const read = readWaitlistOfferToken(createWaitlistOfferToken(claims));
    expect(read).toEqual(claims);
  });

  it("rejects a tampered payload, signature or shape", () => {
    const token = createWaitlistOfferToken(claims);
    const [payload, signature] = token.split(".");
    const other = createWaitlistOfferToken({ ...claims, entryId: "entry-2" });

    expect(readWaitlistOfferToken(`${other.split(".")[0]}.${signature}`)).toBeNull();
    expect(readWaitlistOfferToken(`${payload}.${signature.slice(0, -1)}`)).toBeNull();
    expect(readWaitlistOfferToken(`${payload}.${"A".repeat(signature.length)}`)).toBeNull();
    expect(readWaitlistOfferToken(payload)).toBeNull();
    expect(readWaitlistOfferToken("")).toBeNull();
    expect(readWaitlistOfferToken(".")).toBeNull();
    expect(readWaitlistOfferToken("not-a-token")).toBeNull();
  });

  it("rejects a token minted under a different secret", () => {
    const token = createWaitlistOfferToken(claims);
    process.env.WAITLIST_OFFER_SECRET = "a-completely-different-secret";
    expect(readWaitlistOfferToken(token)).toBeNull();
  });

  it("rejects a payload with the wrong version or a hand-built shape", () => {
    const forged = Buffer.from("w2.entry-1.staff-1.1.2", "utf8").toString("base64url");
    expect(readWaitlistOfferToken(`${forged}.whatever`)).toBeNull();

    const short = Buffer.from("w1.entry-1.staff-1.1", "utf8").toString("base64url");
    expect(readWaitlistOfferToken(`${short}.whatever`)).toBeNull();
  });

  it("binds the token to notifiedAt so a re-offer kills the previous link", () => {
    const first = createWaitlistOfferToken(claims);
    const second = createWaitlistOfferToken({ ...claims, notifiedAtMs: NOW.getTime() + 1 });
    expect(first).not.toBe(second);
    expect(readWaitlistOfferToken(first)?.notifiedAtMs).toBe(NOW.getTime());
    expect(readWaitlistOfferToken(second)?.notifiedAtMs).toBe(NOW.getTime() + 1);
  });

  it("refuses to mint anything without a configured secret", () => {
    delete process.env.WAITLIST_OFFER_SECRET;
    delete process.env.APPOINTMENT_TOKEN_SECRET;
    delete process.env.JWT_SECRET;
    expect(() => createWaitlistOfferToken(claims)).toThrow("OFFER_SECRET_MISSING");
  });
});

describe("offer timings", () => {
  it("clamps configured values into sane bounds", () => {
    process.env.WAITLIST_OFFER_TTL_MINUTES = "0";
    expect(offerTtlMinutes()).toBe(1);
    process.env.WAITLIST_OFFER_TTL_MINUTES = "99999";
    expect(offerTtlMinutes()).toBe(24 * 60);
    process.env.WAITLIST_OFFER_TTL_MINUTES = "not-a-number";
    expect(offerTtlMinutes()).toBe(DEFAULT_OFFER_TTL_MINUTES);
    process.env.WAITLIST_OFFER_TTL_MINUTES = "   ";
    expect(offerTtlMinutes()).toBe(DEFAULT_OFFER_TTL_MINUTES);
    expect(minOfferLeadMinutes()).toBe(DEFAULT_MIN_OFFER_LEAD_MINUTES);
  });

  it("never lets the cooldown fall below the offer lifetime", () => {
    process.env.WAITLIST_OFFER_TTL_MINUTES = "45";
    process.env.WAITLIST_OFFER_COOLDOWN_MINUTES = "5";
    expect(offerCooldownMinutes()).toBe(45);
    expect(offerCooldownMinutes()).toBeGreaterThanOrEqual(offerTtlMinutes());
  });

  it("clamps an offer to the slot it is offering", () => {
    expect(offerExpiresAt(NOW, SLOT_START).getTime()).toBe(NOW.getTime() + TTL_MS);
    const late = new Date(SLOT_START.getTime() - 5 * MINUTE);
    expect(offerExpiresAt(late, SLOT_START).getTime()).toBe(SLOT_START.getTime());
  });
});

describe("join: window validation", () => {
  it("rejects a window that ends before it starts, and a zero-length one", async () => {
    await expect(
      service().join(joinInput({ earliestAt: WINDOW_TO, latestAt: WINDOW_FROM }), NOW),
    ).rejects.toThrow("WINDOW_INVALID");
    await expect(
      service().join(joinInput({ earliestAt: WINDOW_FROM, latestAt: WINDOW_FROM }), NOW),
    ).rejects.toThrow("WINDOW_INVALID");
  });

  it("rejects a window that has already closed", async () => {
    await expect(
      service().join(
        joinInput({
          earliestAt: new Date(NOW.getTime() - 3 * HOUR),
          latestAt: new Date(NOW.getTime() - HOUR),
        }),
        NOW,
      ),
    ).rejects.toThrow("WINDOW_IN_PAST");
  });

  it("rejects absurd windows on both ends", async () => {
    await expect(
      service().join(joinInput({ earliestAt: new Date(0), latestAt: WINDOW_TO }), NOW),
    ).rejects.toThrow("WINDOW_TOO_LONG");

    await expect(
      service().join(
        joinInput({
          earliestAt: WINDOW_FROM,
          latestAt: new Date(WINDOW_FROM.getTime() + (MAX_WAITLIST_WINDOW_DAYS + 1) * DAY),
        }),
        NOW,
      ),
    ).rejects.toThrow("WINDOW_TOO_LONG");

    await expect(
      service().join(
        joinInput({
          earliestAt: new Date(NOW.getTime() + (WAITLIST_HORIZON_DAYS + 1) * DAY - HOUR),
          latestAt: new Date(NOW.getTime() + (WAITLIST_HORIZON_DAYS + 1) * DAY),
        }),
        NOW,
      ),
    ).rejects.toThrow("WINDOW_TOO_FAR_AHEAD");
  });

  it("accepts a window that ends exactly on the horizon", async () => {
    const latestAt = new Date(NOW.getTime() + WAITLIST_HORIZON_DAYS * DAY);
    const result = await service().join(
      joinInput({ earliestAt: new Date(latestAt.getTime() - DAY), latestAt }),
      NOW,
    );
    expect(result.created).toBe(true);
  });

  it("rejects a window shorter than the treatment", async () => {
    await expect(
      service().join(
        joinInput({
          earliestAt: new Date(NOW.getTime() + HOUR),
          latestAt: new Date(NOW.getTime() + HOUR + 30 * MINUTE),
        }),
        NOW,
      ),
    ).rejects.toThrow("WINDOW_TOO_SHORT");
  });

  it("measures the remaining window from now, not from a start already in the past", async () => {
    await expect(
      service().join(
        joinInput({
          earliestAt: new Date(NOW.getTime() - 5 * HOUR),
          latestAt: new Date(NOW.getTime() + 30 * MINUTE),
        }),
        NOW,
      ),
    ).rejects.toThrow("WINDOW_TOO_SHORT");

    const result = await service().join(
      joinInput({
        earliestAt: new Date(NOW.getTime() - 5 * HOUR),
        latestAt: new Date(NOW.getTime() + 90 * MINUTE),
      }),
      NOW,
    );
    expect(result.created).toBe(true);
  });

  it("rejects malformed input before touching the database", async () => {
    await expect(service().join(joinInput({ earliestAt: "not-a-date" }), NOW)).rejects.toThrow(
      "INVALID_INPUT",
    );
    await expect(service().join(joinInput({ customerId: "  " }), NOW)).rejects.toThrow(
      "INVALID_INPUT",
    );
    await expect(service().join(joinInput({ surprise: true }), NOW)).rejects.toThrow(
      "INVALID_INPUT",
    );
    await expect(service().join(joinInput({ locale: "es" }), NOW)).rejects.toThrow("INVALID_INPUT");
    expect(db.prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(db.waitlists).toHaveLength(0);
  });
});

describe("join: references", () => {
  it("refuses unknown, deleted and anonymised customers", async () => {
    await expect(service().join(joinInput({ customerId: "nobody" }), NOW)).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );
    await expect(service().join(joinInput({ customerId: "customer-erased" }), NOW)).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );
    await expect(
      service().join(joinInput({ customerId: "customer-anonymous" }), NOW),
    ).rejects.toThrow("CUSTOMER_NOT_FOUND");
  });

  it("refuses unknown and retired services", async () => {
    await expect(service().join(joinInput({ serviceId: "nope" }), NOW)).rejects.toThrow(
      "SERVICE_NOT_FOUND",
    );
    await expect(service().join(joinInput({ serviceId: "service-retired" }), NOW)).rejects.toThrow(
      "SERVICE_INACTIVE",
    );
  });

  it("refuses a staff preference the salon cannot honour", async () => {
    await expect(service().join(joinInput({ staffId: "ghost" }), NOW)).rejects.toThrow(
      "STAFF_NOT_FOUND",
    );
    await expect(service().join(joinInput({ staffId: "staff-3" }), NOW)).rejects.toThrow(
      "STAFF_NOT_ELIGIBLE",
    );
    await expect(service().join(joinInput({ staffId: "staff-4" }), NOW)).rejects.toThrow(
      "STAFF_NOT_ELIGIBLE",
    );
  });

  it("takes the locale from the customer when the form does not send one", async () => {
    const result = await service().join(joinInput({ customerId: "customer-2" }), NOW);
    expect(result.entry).toMatchObject({ locale: "it", channel: "web", status: "active" });

    const explicit = await service().join(
      joinInput({ customerId: "customer-3", locale: "fr", channel: "sms" }),
      NOW,
    );
    expect(explicit.entry).toMatchObject({ locale: "fr", channel: "sms" });
  });
});

describe("join: deduplication and the per-customer cap", () => {
  it("returns the existing entry instead of stacking a second one", async () => {
    const first = await service().join(joinInput(), NOW);
    const second = await service().join(joinInput(), NOW);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.duplicateOf).toBe(first.entry.id);
    expect(second.entry.id).toBe(first.entry.id);
    expect(db.waitlists).toHaveLength(1);
  });

  it("treats a merely overlapping window as the same request", async () => {
    const first = await service().join(joinInput(), NOW);
    const overlapping = await service().join(
      joinInput({
        earliestAt: new Date(WINDOW_TO.getTime() - MINUTE),
        latestAt: new Date(WINDOW_TO.getTime() + 5 * HOUR),
      }),
      NOW,
    );
    expect(overlapping.created).toBe(false);
    expect(overlapping.entry.id).toBe(first.entry.id);
  });

  it("keeps genuinely different requests apart", async () => {
    await service().join(joinInput(), NOW);

    const touching = await service().join(
      joinInput({ earliestAt: WINDOW_TO, latestAt: new Date(WINDOW_TO.getTime() + 5 * HOUR) }),
      NOW,
    );
    const otherStaff = await service().join(joinInput({ staffId: "staff-2" }), NOW);
    const otherService = await service().join(joinInput({ serviceId: "service-color" }), NOW);

    expect([touching.created, otherStaff.created, otherService.created]).toEqual([
      true,
      true,
      true,
    ]);
    expect(db.waitlists).toHaveLength(4);
  });

  it("stops at the per-customer cap but still honours a re-submit", async () => {
    for (let index = 0; index < MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER; index += 1) {
      seedEntry({
        earliestAt: new Date(WINDOW_FROM.getTime() + index * 2 * DAY),
        latestAt: new Date(WINDOW_FROM.getTime() + index * 2 * DAY + 6 * HOUR),
      });
    }

    await expect(
      service().join(
        joinInput({
          earliestAt: new Date(WINDOW_FROM.getTime() + 20 * DAY),
          latestAt: new Date(WINDOW_FROM.getTime() + 20 * DAY + 6 * HOUR),
        }),
        NOW,
      ),
    ).rejects.toThrow("TOO_MANY_WAITLIST_ENTRIES");

    const resubmit = await service().join(joinInput(), NOW);
    expect(resubmit.created).toBe(false);
    expect(resubmit.entry.id).toBe("entry-1");
    expect(db.waitlists).toHaveLength(MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER);
  });

  it("returns the entry that already holds a live offer", async () => {
    seedEntry();
    const offer = (await service().notifyMatches(SLOT, { now: NOW, limit: 1 })).offers[0];

    const resubmit = await service().join(joinInput(), NOW);
    expect(resubmit.created).toBe(false);
    expect(resubmit.entry.id).toBe(offer.entryId);
    expect(db.waitlists).toHaveLength(1);
    expect(storedEntry(offer.entryId).status).toBe("notified");
  });

  it("counts only open entries towards the cap", async () => {
    for (const status of ["cancelled", "converted", "expired"]) {
      seedEntry({
        status,
        earliestAt: new Date(WINDOW_FROM.getTime() - 40 * DAY),
        latestAt: new Date(WINDOW_FROM.getTime() - 39 * DAY),
      });
    }
    const result = await service().join(joinInput(), NOW);
    expect(result.created).toBe(true);
  });

  it("survives a double-tapped form button submitted twice at once", async () => {
    const [first, second] = await Promise.all([
      service().join(joinInput(), NOW),
      service().join(joinInput(), NOW),
    ]);

    expect(db.waitlists).toHaveLength(1);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.entry.id).toBe(second.entry.id);
  });

  it("does not let two concurrent joins push the customer past the cap", async () => {
    for (let index = 0; index < MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER - 1; index += 1) {
      seedEntry({
        earliestAt: new Date(WINDOW_FROM.getTime() + index * 2 * DAY),
        latestAt: new Date(WINDOW_FROM.getTime() + index * 2 * DAY + 6 * HOUR),
      });
    }

    const window = (offsetDays: number) => ({
      earliestAt: new Date(WINDOW_FROM.getTime() + offsetDays * DAY),
      latestAt: new Date(WINDOW_FROM.getTime() + offsetDays * DAY + 6 * HOUR),
    });

    const settled = await Promise.allSettled([
      service().join(joinInput(window(20)), NOW),
      service().join(joinInput(window(24)), NOW),
    ]);

    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WaitlistError);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe("TOO_MANY_WAITLIST_ENTRIES");
    expect(db.waitlists).toHaveLength(MAX_OPEN_WAITLIST_ENTRIES_PER_CUSTOMER);
  });
});

describe("join: the customer who is already booked", () => {
  it("reports the appointments already held inside the window and joins anyway", async () => {
    const inside = seedAppointment({
      id: "held-inside",
      startsAt: new Date(WINDOW_FROM.getTime() + HOUR),
    });
    seedAppointment({
      id: "held-outside",
      startsAt: new Date(WINDOW_TO.getTime() + HOUR),
      endsAt: new Date(WINDOW_TO.getTime() + 2 * HOUR),
    });
    seedAppointment({
      id: "held-cancelled",
      status: "cancelled",
      startsAt: new Date(WINDOW_FROM.getTime() + 2 * HOUR),
    });
    seedAppointment({ id: "held-other-service", serviceId: "service-color" });

    const result = await service().join(joinInput(), NOW);
    expect(result.created).toBe(true);
    expect(result.heldAppointmentIds).toEqual([inside.id]);
  });
});

describe("cancel and convert", () => {
  it("is idempotent and never rolls a converted entry back", async () => {
    const entry = seedEntry();
    await service().cancel(entry.id);
    expect(storedEntry(entry.id).status).toBe("cancelled");
    await expect(service().cancel(entry.id)).resolves.toMatchObject({ status: "cancelled" });

    const converted = seedEntry({ status: "converted", convertedAppointmentId: "appointment-9" });
    await service().cancel(converted.id);
    expect(storedEntry(converted.id).status).toBe("converted");

    await expect(service().cancel("nope")).rejects.toThrow("ENTRY_NOT_FOUND");
  });

  it("links an entry to an appointment booked through another channel", async () => {
    const entry = seedEntry();
    const appointment = seedAppointment({ id: "desk-booking" });

    const converted = await service().convert(entry.id, appointment.id);
    expect(converted).toMatchObject({
      status: "converted",
      convertedAppointmentId: "desk-booking",
    });
    await expect(service().convert(entry.id, appointment.id)).resolves.toMatchObject({
      status: "converted",
    });
  });

  it("refuses to convert against the wrong appointment", async () => {
    const entry = seedEntry();
    const otherCustomer = seedAppointment({ id: "wrong-customer", customerId: "customer-2" });
    const otherService = seedAppointment({ id: "wrong-service", serviceId: "service-color" });
    const cancelled = seedAppointment({ id: "gone", status: "cancelled" });

    await expect(service().convert(entry.id, "missing")).rejects.toThrow("APPOINTMENT_NOT_FOUND");
    await expect(service().convert(entry.id, cancelled.id)).rejects.toThrow(
      "APPOINTMENT_CANCELLED",
    );
    await expect(service().convert(entry.id, otherCustomer.id)).rejects.toThrow(
      "APPOINTMENT_CUSTOMER_MISMATCH",
    );
    await expect(service().convert(entry.id, otherService.id)).rejects.toThrow(
      "APPOINTMENT_SERVICE_MISMATCH",
    );

    const good = seedAppointment({ id: "right-one" });
    await service().convert(entry.id, good.id);
    await expect(service().convert(entry.id, "right-one-again")).rejects.toThrow(
      "APPOINTMENT_NOT_FOUND",
    );

    const second = seedAppointment({ id: "second-booking" });
    await expect(service().convert(entry.id, second.id)).rejects.toThrow("ALREADY_CONVERTED");
  });
});

describe("findMatches: window fit", () => {
  it("accepts a slot that just fits and rejects one that overruns by a millisecond", async () => {
    const fits = seedEntry({ earliestAt: SLOT_START, latestAt: SLOT_END });
    seedEntry({ earliestAt: new Date(SLOT_START.getTime() + 1), latestAt: WINDOW_TO });
    seedEntry({ earliestAt: WINDOW_FROM, latestAt: new Date(SLOT_END.getTime() - 1) });

    const matches = await service().findMatches(SLOT, { now: NOW });
    expect(matches.map((match) => match.entry.id)).toEqual([fits.id]);
  });

  it("uses containment by default and intersection only when asked", async () => {
    const partial = seedEntry({
      earliestAt: new Date(SLOT_START.getTime() + 30 * MINUTE),
      latestAt: new Date(SLOT_END.getTime() + 30 * MINUTE),
    });
    const touching = seedEntry({
      earliestAt: SLOT_END,
      latestAt: new Date(SLOT_END.getTime() + 3 * HOUR),
    });

    expect(await service().findMatches(SLOT, { now: NOW })).toHaveLength(0);

    const overlapping = await service().findMatches(SLOT, { now: NOW, windowFit: "overlap" });
    expect(overlapping.map((match) => match.entry.id)).toEqual([partial.id]);
    expect(overlapping.map((match) => match.entry.id)).not.toContain(touching.id);
  });

  it("respects the staff preference in both directions", async () => {
    const anyStaff = seedEntry();
    const sameStaff = seedEntry({ staffId: "staff-1" });
    seedEntry({ staffId: "staff-2" });

    const matches = await service().findMatches(SLOT, { now: NOW });
    expect(matches.map((match) => match.entry.id)).toEqual([anyStaff.id, sameStaff.id]);
  });

  it("ignores other services, closed entries and erased customers", async () => {
    const keep = seedEntry();
    seedEntry({ serviceId: "service-color" });
    seedEntry({ status: "cancelled" });
    seedEntry({ status: "expired" });
    seedEntry({ status: "converted" });
    seedEntry({ customerId: "customer-erased" });
    seedEntry({ customerId: "customer-anonymous" });

    const matches = await service().findMatches(SLOT, { now: NOW });
    expect(matches.map((match) => match.entry.id)).toEqual([keep.id]);
  });

  it("rejects an unusable freed slot", async () => {
    await expect(service().findMatches({ ...SLOT, serviceId: "nope" })).rejects.toThrow(
      "SERVICE_NOT_FOUND",
    );
    await expect(service().findMatches({ ...SLOT, serviceId: "service-retired" })).rejects.toThrow(
      "SERVICE_INACTIVE",
    );
    await expect(service().findMatches({ ...SLOT, staffId: "" } as FreedSlot)).rejects.toThrow(
      "INVALID_INPUT",
    );
  });
});

describe("findMatches: ordering", () => {
  it("is strict first-come-first-served with a stable id tie-break", async () => {
    const shared = new Date(NOW.getTime() - 2 * HOUR);
    // Inserted back to front on purpose: a sort that only honours createdAt would keep
    // the insertion order for the tie and pass by accident.
    seedEntry({ id: "zz-late-id", createdAt: shared, updatedAt: shared });
    seedEntry({ id: "aa-early-id", createdAt: shared, updatedAt: shared });
    seedEntry({ id: "mm-mid-id", createdAt: shared, updatedAt: shared });
    seedEntry({ id: "oldest", createdAt: new Date(shared.getTime() - HOUR) });
    seedEntry({ id: "newest", createdAt: new Date(shared.getTime() + HOUR) });

    const expected = ["oldest", "aa-early-id", "mm-mid-id", "zz-late-id", "newest"];
    const first = await service().findMatches(SLOT, { now: NOW });
    const second = await service().findMatches(SLOT, { now: NOW });

    expect(first.map((match) => match.entry.id)).toEqual(expected);
    expect(second.map((match) => match.entry.id)).toEqual(expected);
    expect(first.map((match) => match.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("ranks by entitlement and applies the limit afterwards", async () => {
    seedEntry({ id: "first" });
    seedEntry({ id: "second" });
    seedEntry({ id: "third" });

    const limited = await service().findMatches(SLOT, { now: NOW, limit: 2 });
    expect(limited.map((match) => [match.entry.id, match.rank])).toEqual([
      ["first", 1],
      ["second", 2],
    ]);
    expect(await service().findMatches(SLOT, { now: NOW, limit: 0 })).toHaveLength(0);
  });

  it("keeps the rank of an entry it hides for being unreachable", async () => {
    seedEntry({ id: "reachable-first" });
    seedEntry({ id: "unreachable", customerId: "customer-4" });
    seedEntry({ id: "reachable-last" });

    const visible = await service().findMatches(SLOT, { now: NOW });
    expect(visible.map((match) => [match.entry.id, match.rank])).toEqual([
      ["reachable-first", 1],
      ["reachable-last", 3],
    ]);

    const all = await service().findMatches(SLOT, { now: NOW, includeUnreachable: true });
    expect(all[1]).toMatchObject({ offerable: false, blockedReason: "UNREACHABLE", target: null });
  });
});

describe("findMatches: why an entry cannot be offered", () => {
  function reasonOf(matches: WaitlistMatch[], id: string): string | undefined {
    return matches.find((match) => match.entry.id === id)?.blockedReason;
  }

  it("protects a live offer and then holds the entry back for the cooldown", async () => {
    seedEntry({ id: "in-flight", status: "notified", notifiedAt: NOW });

    const during = await service().findMatches(SLOT, { now: new Date(NOW.getTime() + TTL_MS - 1) });
    expect(reasonOf(during, "in-flight")).toBe("OFFER_IN_FLIGHT");

    const afterTtl = await service().findMatches(SLOT, { now: new Date(NOW.getTime() + TTL_MS) });
    expect(reasonOf(afterTtl, "in-flight")).toBe("OFFER_COOLDOWN");

    const onCooldownEdge = await service().findMatches(SLOT, {
      now: new Date(NOW.getTime() + COOLDOWN_MS),
    });
    expect(reasonOf(onCooldownEdge, "in-flight")).toBe("OFFER_COOLDOWN");

    const afterCooldown = await service().findMatches(SLOT, {
      now: new Date(NOW.getTime() + COOLDOWN_MS + 1),
    });
    expect(reasonOf(afterCooldown, "in-flight")).toBeUndefined();
  });

  it("keeps a released but still cooling entry out of the offerable set", async () => {
    seedEntry({ id: "released", status: "active", notifiedAt: new Date(NOW.getTime() - TTL_MS) });
    const matches = await service().findMatches(SLOT, { now: NOW });
    expect(matches[0]).toMatchObject({ offerable: false, blockedReason: "OFFER_COOLDOWN" });
  });

  it("reports a window that closed while the entry was still on the list", async () => {
    seedEntry({
      id: "closed",
      earliestAt: new Date(NOW.getTime() - 5 * HOUR),
      latestAt: new Date(NOW.getTime() - MINUTE),
    });
    const matches = await service().findMatches(
      { ...SLOT, startsAt: new Date(NOW.getTime() - 3 * HOUR) },
      { now: NOW, windowFit: "overlap" },
    );
    expect(matches[0]).toMatchObject({ blockedReason: "WINDOW_CLOSED", offerable: false });
  });

  it("routes each entry to the channel the customer can actually receive", async () => {
    seedEntry({ id: "web", customerId: "customer-1", channel: "web" });
    seedEntry({ id: "sms", customerId: "customer-1", channel: "sms" });
    seedEntry({ id: "voice", customerId: "customer-1", channel: "voice" });
    seedEntry({ id: "whatsapp", customerId: "customer-1", channel: "whatsapp" });
    seedEntry({ id: "sms-without-phone", customerId: "customer-2", channel: "sms" });
    seedEntry({ id: "web-without-email", customerId: "customer-3", channel: "web" });

    const matches = await service().findMatches(SLOT, { now: NOW });
    const targets = Object.fromEntries(
      matches.map((match) => [match.entry.id, match.target?.channel]),
    );
    expect(targets).toEqual({
      web: "web",
      sms: "sms",
      voice: "sms",
      whatsapp: "whatsapp",
      "sms-without-phone": "web",
      "web-without-email": "sms",
    });
  });
});

describe("notifyMatches: when the slot itself is unusable", () => {
  it("refuses a slot in the past or too close to now", async () => {
    seedEntry();
    const past = await service().notifyMatches(
      { ...SLOT, startsAt: new Date(NOW.getTime() - MINUTE) },
      { now: NOW },
    );
    expect(past.aborted).toBe("SLOT_IN_PAST");

    const soon = await service().notifyMatches(
      { ...SLOT, startsAt: new Date(NOW.getTime() + DEFAULT_MIN_OFFER_LEAD_MINUTES * MINUTE - 1) },
      { now: NOW },
    );
    expect(soon.aborted).toBe("SLOT_TOO_SOON");
    expect(notificationSend).not.toHaveBeenCalled();
    expect(storedEntry("entry-1").status).toBe("active");
  });

  it("refuses a slot somebody already took", async () => {
    seedEntry();
    seedAppointment({ startsAt: new Date(SLOT_START.getTime() + 30 * MINUTE) });
    const result = await service().notifyMatches(SLOT, { now: NOW });
    expect(result.aborted).toBe("SLOT_TAKEN");
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it("still offers a slot that only touches the previous appointment", async () => {
    seedEntry();
    seedAppointment({
      startsAt: new Date(SLOT_START.getTime() - HOUR),
      endsAt: SLOT_START,
      serviceId: "service-cut",
    });
    const result = await service().notifyMatches(SLOT, { now: NOW });
    expect(result.aborted).toBeUndefined();
    expect(result.offers).toHaveLength(1);
  });

  it("respects the buffer the previous treatment needs afterwards", async () => {
    seedEntry();
    seedAppointment({
      startsAt: new Date(SLOT_START.getTime() - 90 * MINUTE),
      endsAt: SLOT_START,
      serviceId: "service-color",
    });
    const result = await service().notifyMatches(SLOT, { now: NOW });
    expect(result.aborted).toBe("SLOT_TAKEN");
  });

  it("ignores a cancelled appointment on the same chair", async () => {
    seedEntry();
    seedAppointment({ status: "cancelled" });
    const result = await service().notifyMatches(SLOT, { now: NOW });
    expect(result.aborted).toBeUndefined();
  });
});

describe("notifyMatches: handing the slot out", () => {
  it("offers to a cohort of the configured size and marks each one notified", async () => {
    for (let index = 0; index < 5; index += 1) seedEntry();

    const result = await service().notifyMatches(SLOT, { now: NOW });

    expect(result.offers).toHaveLength(DEFAULT_OFFERS_PER_SLOT);
    expect(result.matched).toBe(5);
    expect(result.offerExpiresAt.getTime()).toBe(NOW.getTime() + TTL_MS);
    for (const offer of result.offers) {
      const stored = storedEntry(offer.entryId);
      expect(stored.status).toBe("notified");
      expect(stored.notifiedAt).toEqual(NOW);
      expect(readWaitlistOfferToken(offer.token)).toEqual({
        entryId: offer.entryId,
        staffId: "staff-1",
        slotStartsAt: SLOT_START,
        notifiedAtMs: NOW.getTime(),
      });
      expect(offer.claimUrl).toContain(`entry=${offer.entryId}`);
      expect(offer.claimUrl).toContain(`token=${encodeURIComponent(offer.token)}`);
    }
    expect(storedEntry("entry-4").status).toBe("active");
    expect(storedEntry("entry-5").status).toBe("active");
  });

  it("writes the salon's wall clock into the message whatever the host zone is", async () => {
    seedEntry({ locale: "de" });
    seedEntry({ locale: "it", customerId: "customer-2" });

    await service().notifyMatches(SLOT, { now: NOW, limit: 2 });

    const [german, italian] = notificationSend.mock.calls.map((call) => call[0]);
    expect(german.message).toContain("14:00-15:00");
    expect(german.message).toContain("10:20");
    expect(german.subject).toContain("Termin frei geworden");
    expect(german.message).toContain("Haircut DE");
    expect(italian.subject).toContain("si è liberato");
    expect(italian.message).toContain("Haircut IT");
    expect(italian.message).toContain("14:00-15:00");
    expect(italian.recipient).toBe("luca@example.com");
  });

  it("records why every entry it walked past was skipped", async () => {
    seedEntry({ id: "unreachable", customerId: "customer-4" });
    seedEntry({ id: "cooling", notifiedAt: new Date(NOW.getTime() - TTL_MS) });
    seedEntry({ id: "good" });

    const result = await service().notifyMatches(SLOT, { now: NOW });
    expect(result.offers.map((offer) => offer.entryId)).toEqual(["good"]);
    expect(result.skipped).toEqual([
      { entryId: "unreachable", reason: "UNREACHABLE" },
      { entryId: "cooling", reason: "OFFER_COOLDOWN" },
    ]);
  });

  it("gives an entry its turn back when the message could not be delivered", async () => {
    seedEntry();
    notificationSend.mockResolvedValue({
      status: "failed",
      provider: "test",
      reason: "MAILBOX_FULL",
    });

    const result = await service().notifyMatches(SLOT, { now: NOW, limit: 1 });
    expect(result.offers[0]).toMatchObject({ status: "failed", reason: "MAILBOX_FULL" });

    const stored = storedEntry("entry-1");
    expect(stored.status).toBe("active");
    expect(stored.notifiedAt).toBeNull();

    const matches = await service().findMatches(SLOT, { now: new Date(NOW.getTime() + MINUTE) });
    expect(matches[0].offerable).toBe(true);
  });

  it("keeps a previous cooldown intact when the retry also bounces", async () => {
    const earlier = new Date(NOW.getTime() - COOLDOWN_MS - MINUTE);
    seedEntry({ notifiedAt: earlier });
    notificationSend.mockResolvedValue({ status: "failed", provider: "test" });

    await service().notifyMatches(SLOT, { now: NOW, limit: 1 });
    expect(storedEntry("entry-1")).toMatchObject({ status: "active", notifiedAt: earlier });
  });

  it("spends a place in the cohort on a bounced message, but not the entry's turn", async () => {
    seedEntry({ id: "bounces" });
    seedEntry({ id: "reachable" });
    notificationSend.mockResolvedValueOnce({ status: "failed", provider: "test" });

    const result = await service().notifyMatches(SLOT, { now: NOW, limit: 1 });
    expect(result.offers.map((offer) => offer.entryId)).toEqual(["bounces"]);
    expect(storedEntry("reachable").status).toBe("active");

    const retry = await service().notifyMatches(SLOT, { now: new Date(NOW.getTime() + MINUTE) });
    expect(retry.offers.map((offer) => offer.entryId)).toEqual(["bounces", "reachable"]);
  });

  it("never hands the same entry two live offers when two cancellations race", async () => {
    seedEntry();
    seedEntry();

    const [first, second] = await Promise.all([
      service().notifyMatches(SLOT, { now: NOW }),
      service().notifyMatches(SLOT, { now: NOW }),
    ]);

    const offered = [...first.offers, ...second.offers].map((offer) => offer.entryId);
    expect(offered).toHaveLength(2);
    expect(new Set(offered).size).toBe(2);

    const stolen = [...first.skipped, ...second.skipped].filter(
      (skip) => skip.reason === "OFFER_TAKEN_CONCURRENTLY",
    );
    expect(stolen).toHaveLength(2);
    expect(notificationSend).toHaveBeenCalledTimes(2);
  });

  it("degrades to a strictly exclusive offer when the salon sets limit 1", async () => {
    seedEntry();
    seedEntry();
    const result = await service().notifyMatches(SLOT, { now: NOW, limit: 1 });
    expect(result.offers).toHaveLength(1);
    expect(storedEntry("entry-2").status).toBe("active");
  });

  it("never lets one entry hold live offers for two different slots at once", async () => {
    seedEntry();
    const first = await service().notifyMatches(SLOT, { now: NOW, limit: 1 });
    const second = await service().notifyMatches(
      { ...SLOT, startsAt: new Date(SLOT_START.getTime() + 2 * HOUR) },
      { now: NOW, limit: 1 },
    );

    expect(first.offers).toHaveLength(1);
    expect(second.offers).toHaveLength(0);
    expect(second.skipped).toEqual([{ entryId: "entry-1", reason: "OFFER_IN_FLIGHT" }]);

    const claimed = await service().claim(first.offers[0].entryId, {
      token: first.offers[0].token,
      now: NOW,
    });
    expect(claimed.won).toBe(true);
    if (claimed.won) expect(claimed.appointment.startsAt).toEqual(SLOT_START);
  });

  it("offers a slot that sits exactly on the minimum lead time", async () => {
    seedEntry();
    const edge = new Date(SLOT_START.getTime() - DEFAULT_MIN_OFFER_LEAD_MINUTES * MINUTE);
    const result = await service().notifyMatches(SLOT, { now: edge, limit: 1 });
    expect(result.aborted).toBeUndefined();
    expect(result.offers).toHaveLength(1);
  });

  it("never offers a slot that only overlaps the window the customer gave", async () => {
    seedEntry({
      id: "half-interested",
      earliestAt: new Date(SLOT_START.getTime() + 30 * MINUTE),
      latestAt: WINDOW_TO,
    });

    const admin = await service().findMatches(SLOT, { now: NOW, windowFit: "overlap" });
    expect(admin.map((match) => match.entry.id)).toEqual(["half-interested"]);

    const result = await service().notifyMatches(SLOT, { now: NOW });
    expect(result.matched).toBe(0);
    expect(result.offers).toHaveLength(0);
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it("does not let a name full of regex replacement patterns rewrite the message", async () => {
    const customer = db.customers.find((row) => row.id === "customer-1") as Row;
    customer.firstName = "$&$`$'$$";
    seedEntry();

    await service().notifyMatches(SLOT, { now: NOW, limit: 1 });

    const sent = notificationSend.mock.calls[0][0] as { message: string };
    expect(sent.message).toContain("$&$`$'$$");
    expect(sent.message).not.toContain("{{");
    expect(sent.message).toContain("14:00-15:00");
    expect(sent.message).toContain("http://localhost:3000/de/waitlist/claim");
  });
});

describe("claim: the race for one chair", () => {
  async function offerTo(count: number, overrides: Row = {}) {
    for (let index = 0; index < count; index += 1) {
      seedEntry({ customerId: `customer-${(index % 3) + 1}`, ...overrides });
    }
    const notified = await service().notifyMatches(SLOT, { now: NOW, limit: count });
    return notified.offers;
  }

  it("turns the winning offer into an appointment carrying the entry's own settings", async () => {
    const [offer] = await offerTo(1, { locale: "fr", channel: "sms", customerId: "customer-3" });

    const result = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    expect(result.won).toBe(true);
    if (!result.won) return;

    expect(result.alreadyClaimed).toBe(false);
    expect(result.appointment).toMatchObject({
      customerId: "customer-3",
      serviceId: "service-cut",
      staffId: "staff-1",
      locale: "fr",
      sourceChannel: "sms",
      status: "pending",
    });
    expect(result.appointment.startsAt).toEqual(SLOT_START);
    expect(result.appointment.endsAt).toEqual(SLOT_END);
    expect(storedEntry(offer.entryId)).toMatchObject({
      status: "converted",
      convertedAppointmentId: result.appointment.id,
    });
    expect(db.statusHistory).toEqual([
      expect.objectContaining({ status: "pending", reason: "waitlist offer claimed" }),
    ]);
  });

  it("produces exactly one winner when two entries claim at the same instant", async () => {
    const offers = await offerTo(2);
    db.prisma.waitlist.findUnique.mockClear();
    db.prisma.$transaction.mockClear();

    const [first, second] = await Promise.all([
      service().claim(offers[0].entryId, { token: offers[0].token, now: NOW }),
      service().claim(offers[1].entryId, { token: offers[1].token, now: NOW }),
    ]);

    // Both claimants read the entry, and passed every pre-flight check, before either
    // transaction opened: a genuine interleaving rather than two sequential calls.
    const reads = db.prisma.waitlist.findUnique.mock.invocationCallOrder;
    const writes = db.prisma.$transaction.mock.invocationCallOrder;
    expect(reads[0]).toBeLessThan(writes[0]);
    expect(reads[1]).toBeLessThan(writes[0]);

    const winners = [first, second].filter((result) => result.won);
    const losers = [first, second].filter((result) => !result.won);
    expect(winners).toHaveLength(1);
    expect(db.appointments).toHaveLength(1);
    expect(db.statusHistory).toHaveLength(1);

    const winnerAppointmentId = db.appointments[0].id;
    expect(losers[0]).toMatchObject({
      won: false,
      reason: "SLOT_TAKEN",
      conflictingAppointmentId: winnerAppointmentId,
    });
  });

  it("puts the loser back at the head of the queue with no cooldown", async () => {
    const offers = await offerTo(2);

    const results = await Promise.all([
      service().claim(offers[0].entryId, { token: offers[0].token, now: NOW }),
      service().claim(offers[1].entryId, { token: offers[1].token, now: NOW }),
    ]);

    const loserIndex = results.findIndex((result) => !result.won);
    const loserId = offers[loserIndex].entryId;
    expect(storedEntry(loserId)).toMatchObject({ status: "active", notifiedAt: null });

    const later = new Date(NOW.getTime() + MINUTE);
    const nextSlot = { ...SLOT, startsAt: new Date(SLOT_START.getTime() + 2 * HOUR) };
    const matches = await service().findMatches(nextSlot, { now: later });
    expect(matches.find((match) => match.entry.id === loserId)?.offerable).toBe(true);
  });

  it("survives five people hammering the same link", async () => {
    const offers = await offerTo(5);

    const results = await Promise.all(
      offers.map((offer) => service().claim(offer.entryId, { token: offer.token, now: NOW })),
    );

    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(db.appointments).toHaveLength(1);
    expect(results.filter((result) => !result.won && result.reason === "SLOT_TAKEN")).toHaveLength(
      4,
    );
  });

  it("loses to a walk-in booked through the normal flow a moment earlier", async () => {
    const [offer] = await offerTo(1);
    db.onTransaction(() => {
      db.onTransaction(null);
      seedAppointment({ id: "walk-in", customerId: "customer-2" });
    });

    const result = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    expect(result).toMatchObject({
      won: false,
      reason: "SLOT_TAKEN",
      conflictingAppointmentId: "walk-in",
    });
    expect(db.appointments.filter((row) => row.id !== "walk-in")).toHaveLength(0);
  });

  it("retries a serialization failure instead of surfacing it", async () => {
    const [offer] = await offerTo(1);
    const before = db.transactionCount();
    db.onTransaction((attempt) => {
      if (attempt === before + 1) {
        throw Object.assign(new Error("could not serialize access"), { code: "P2034" });
      }
    });

    const result = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    expect(result.won).toBe(true);
    expect(db.transactionCount()).toBe(before + 2);
    expect(db.appointments).toHaveLength(1);
  });

  it("gives up on an error that is not a serialization conflict", async () => {
    const [offer] = await offerTo(1);
    db.onTransaction(() => {
      throw new Error("connection reset");
    });

    await expect(service().claim(offer.entryId, { token: offer.token, now: NOW })).rejects.toThrow(
      "connection reset",
    );
    expect(db.appointments).toHaveLength(0);
  });

  it("shows the booking again when the confirmation link is tapped twice", async () => {
    const [offer] = await offerTo(1);
    const first = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    const second = await service().claim(offer.entryId, { token: offer.token, now: NOW });

    expect(first).toMatchObject({ won: true, alreadyClaimed: false });
    expect(second).toMatchObject({ won: true, alreadyClaimed: true });
    if (first.won && second.won) expect(second.appointment.id).toBe(first.appointment.id);
    expect(db.appointments).toHaveLength(1);
  });
});

describe("claim: refusing a bad link", () => {
  async function offerOne(overrides: Row = {}) {
    seedEntry(overrides);
    const result = await service().notifyMatches(SLOT, { now: NOW, limit: 1 });
    return result.offers[0];
  }

  it("refuses a garbled token and a token issued for somebody else", async () => {
    const offer = await offerOne();
    const other = seedEntry({ id: "entry-other" });

    await expect(service().claim(offer.entryId, { token: "nonsense", now: NOW })).rejects.toThrow(
      "OFFER_TOKEN_INVALID",
    );
    await expect(
      service().claim(other.id as string, { token: offer.token, now: NOW }),
    ).rejects.toThrow("OFFER_TOKEN_INVALID");
    await expect(
      service().claim("entry-missing", {
        token: createWaitlistOfferToken({
          entryId: "entry-missing",
          staffId: "staff-1",
          slotStartsAt: SLOT_START,
          notifiedAtMs: NOW.getTime(),
        }),
        now: NOW,
      }),
    ).rejects.toThrow("ENTRY_NOT_FOUND");
    expect(db.appointments).toHaveLength(0);
  });

  it("honours the offer up to the last millisecond and not beyond", async () => {
    const offer = await offerOne();
    const expired = await service().claim(offer.entryId, {
      token: offer.token,
      now: new Date(NOW.getTime() + TTL_MS),
    });
    expect(expired).toMatchObject({ won: false, reason: "OFFER_EXPIRED" });

    const inTime = await service().claim(offer.entryId, {
      token: offer.token,
      now: new Date(NOW.getTime() + TTL_MS - 1),
    });
    expect(inTime.won).toBe(true);
  });

  it("invalidates the first link as soon as the entry is offered again", async () => {
    const first = await offerOne();
    storedEntry(first.entryId).notifiedAt = new Date(NOW.getTime() - COOLDOWN_MS - MINUTE);
    storedEntry(first.entryId).status = "active";

    const later = new Date(NOW.getTime() + MINUTE);
    const second = await service().notifyMatches(SLOT, { now: later, limit: 1 });
    expect(second.offers).toHaveLength(1);

    await expect(
      service().claim(first.entryId, { token: first.token, now: later }),
    ).resolves.toMatchObject({ won: false, reason: "OFFER_NOT_ACTIVE" });

    const winner = await service().claim(second.offers[0].entryId, {
      token: second.offers[0].token,
      now: later,
    });
    expect(winner.won).toBe(true);
  });

  it("does not report a cancelled booking as a won claim", async () => {
    const offer = await offerOne();
    const won = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    expect(won.won).toBe(true);
    db.appointments[0].status = "cancelled";

    const again = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    expect(again).toMatchObject({ won: false, reason: "OFFER_NOT_ACTIVE" });
  });

  it("refuses a claim on an entry that was cancelled in the meantime", async () => {
    const offer = await offerOne();
    await service().cancel(offer.entryId);

    await expect(
      service().claim(offer.entryId, { token: offer.token, now: NOW }),
    ).resolves.toMatchObject({ won: false, reason: "OFFER_NOT_ACTIVE" });
    expect(db.appointments).toHaveLength(0);
  });

  it("refuses a claim once the slot is inside the minimum lead time", async () => {
    const offer = await offerOne();
    const tooLate = new Date(SLOT_START.getTime() - DEFAULT_MIN_OFFER_LEAD_MINUTES * MINUTE + 1);
    const result = await service().claim(offer.entryId, { token: offer.token, now: tooLate });
    expect(result).toMatchObject({ won: false, reason: "OFFER_EXPIRED" });

    process.env.WAITLIST_OFFER_TTL_MINUTES = "600";
    const stillTooLate = await service().claim(offer.entryId, {
      token: offer.token,
      now: tooLate,
    });
    expect(stillTooLate).toMatchObject({ won: false, reason: "SLOT_TOO_SOON" });
  });
});

describe("claim: the customer who is already in another chair", () => {
  it("refuses to double-book and keeps the offer alive for another slot", async () => {
    seedEntry();
    const offer = (await service().notifyMatches(SLOT, { now: NOW, limit: 1 })).offers[0];
    seedAppointment({ id: "other-chair", staffId: "staff-2", customerId: "customer-1" });

    const result = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    expect(result).toMatchObject({
      won: false,
      reason: "CUSTOMER_DOUBLE_BOOKED",
      conflictingAppointmentId: "other-chair",
    });
    expect(db.appointments).toHaveLength(1);
    expect(storedEntry(offer.entryId)).toMatchObject({ status: "notified" });
  });

  it("lets a waiting customer take an earlier slot while still holding a later one", async () => {
    const joined = await service().join(joinInput(), NOW);
    seedAppointment({
      id: "friday",
      startsAt: new Date(WINDOW_TO.getTime() - HOUR),
      endsAt: WINDOW_TO,
    });
    expect(joined.heldAppointmentIds).toEqual([]);

    const offer = (await service().notifyMatches(SLOT, { now: NOW, limit: 1 })).offers[0];
    const result = await service().claim(offer.entryId, { token: offer.token, now: NOW });

    expect(result.won).toBe(true);
    expect(db.appointments.map((row) => row.id).sort()).toEqual(["appointment-2", "friday"]);
    expect(storedEntry(joined.entry.id).status).toBe("converted");
  });

  it("counts a cancelled appointment as no conflict at all", async () => {
    seedEntry();
    const offer = (await service().notifyMatches(SLOT, { now: NOW, limit: 1 })).offers[0];
    seedAppointment({ id: "dropped", staffId: "staff-2", status: "cancelled" });

    const result = await service().claim(offer.entryId, { token: offer.token, now: NOW });
    expect(result.won).toBe(true);
  });
});

describe("expire", () => {
  it("releases a lapsed offer only once the full lifetime has passed", async () => {
    seedEntry({ id: "lapsing", status: "notified", notifiedAt: NOW });

    await expect(service().expire(new Date(NOW.getTime() + TTL_MS))).resolves.toMatchObject({
      releasedOffers: 0,
    });
    expect(storedEntry("lapsing").status).toBe("notified");

    await expect(service().expire(new Date(NOW.getTime() + TTL_MS + 1))).resolves.toMatchObject({
      releasedOffers: 1,
    });
    const released = storedEntry("lapsing");
    expect(released.status).toBe("active");
    expect(released.notifiedAt).toEqual(NOW);
  });

  it("expires closed windows, cancels erased customers and leaves the rest alone", async () => {
    seedEntry({
      id: "lapsed",
      status: "notified",
      notifiedAt: new Date(NOW.getTime() - 2 * TTL_MS),
    });
    seedEntry({ id: "closed", latestAt: new Date(NOW.getTime() - MINUTE) });
    seedEntry({ id: "erased", customerId: "customer-erased" });
    seedEntry({ id: "anonymous", customerId: "customer-anonymous" });
    seedEntry({ id: "converted", status: "converted" });
    seedEntry({ id: "cancelled", status: "cancelled" });
    seedEntry({ id: "healthy" });

    await expect(service().expire(NOW)).resolves.toEqual({
      releasedOffers: 1,
      expiredWindows: 1,
      cancelledForErasedCustomers: 2,
    });

    expect(storedEntry("lapsed").status).toBe("active");
    expect(storedEntry("closed").status).toBe("expired");
    expect(storedEntry("erased").status).toBe("cancelled");
    expect(storedEntry("anonymous").status).toBe("cancelled");
    expect(storedEntry("converted").status).toBe("converted");
    expect(storedEntry("cancelled").status).toBe("cancelled");
    expect(storedEntry("healthy").status).toBe("active");
  });

  it("never releases an offer whose window closed underneath it", async () => {
    seedEntry({
      id: "both",
      status: "notified",
      notifiedAt: new Date(NOW.getTime() - 2 * TTL_MS),
      latestAt: new Date(NOW.getTime() - MINUTE),
    });
    await expect(service().expire(NOW)).resolves.toMatchObject({
      releasedOffers: 0,
      expiredWindows: 1,
    });
    expect(storedEntry("both").status).toBe("expired");
  });

  it("counts every row once when two cron runs overlap", async () => {
    seedEntry({
      id: "lapsed",
      status: "notified",
      notifiedAt: new Date(NOW.getTime() - 2 * TTL_MS),
    });
    seedEntry({ id: "closed", latestAt: new Date(NOW.getTime() - MINUTE) });
    seedEntry({ id: "erased", customerId: "customer-erased" });

    const [first, second] = await Promise.all([service().expire(NOW), service().expire(NOW)]);

    expect(first.releasedOffers + second.releasedOffers).toBe(1);
    expect(first.expiredWindows + second.expiredWindows).toBe(1);
    expect(first.cancelledForErasedCustomers + second.cancelledForErasedCustomers).toBe(1);

    await expect(service().expire(NOW)).resolves.toEqual({
      releasedOffers: 0,
      expiredWindows: 0,
      cancelledForErasedCustomers: 0,
    });
  });

  it("hands a released entry to the next cancellation once its cooldown is over", async () => {
    seedEntry({ id: "quiet", status: "notified", notifiedAt: NOW });
    await service().expire(new Date(NOW.getTime() + TTL_MS + 1));

    const soon = new Date(NOW.getTime() + TTL_MS + 2);
    const blocked = await service().notifyMatches(SLOT, { now: soon });
    expect(blocked.offers).toHaveLength(0);
    expect(blocked.skipped).toEqual([{ entryId: "quiet", reason: "OFFER_COOLDOWN" }]);

    const later = new Date(NOW.getTime() + COOLDOWN_MS + 1);
    const offered = await service().notifyMatches(SLOT, { now: later });
    expect(offered.offers.map((offer) => offer.entryId)).toEqual(["quiet"]);
  });
});
