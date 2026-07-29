import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { db } = vi.hoisted(() => {
  // Anchored to the suite's NOW. A 1970 epoch would make every "is this row older than
  // X" comparison in a fake trivially true and hide the very thing under test.
  const ANCHOR_MS = Date.parse("2026-01-12T08:00:00.000Z");

  const services: Row[] = [];
  const customers: Row[] = [];
  const staffProfiles: Row[] = [];
  const staffServices: Row[] = [];
  const businessHours: Row[] = [];
  const availabilityRules: Row[] = [];
  const timeOffs: Row[] = [];
  const appointments: Row[] = [];
  const seriesRows: Row[] = [];
  const history: Row[] = [];
  const transactionOptions: unknown[] = [];
  const dataTables: Row[][] = [
    services,
    customers,
    staffProfiles,
    staffServices,
    businessHours,
    availabilityRules,
    timeOffs,
    appointments,
    seriesRows,
    history,
  ];

  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let beforeTransaction: (() => void) | null = null;

  function tick(): Date {
    sequence += 1;
    return new Date(ANCHOR_MS + sequence);
  }

  type Undo = { table: Row[]; length: number; rows: Row[] };

  /**
   * Rows are restored in place rather than replaced, so a test that holds a reference to
   * a seeded row still sees the rolled back values. Without this the fake would happily
   * keep a cursor move whose transaction aborted, which is the one thing `commit` claims
   * can never happen.
   */
  function snapshot(): Undo[] {
    return dataTables.map((table) => ({
      table,
      length: table.length,
      rows: table.map((row) => ({ ...row })),
    }));
  }

  function rollback(undo: Undo[]): void {
    for (const entry of undo) {
      entry.table.length = entry.length;
      entry.rows.forEach((saved, index) => {
        const row = entry.table[index] as Row;
        for (const key of Object.keys(row)) delete row[key];
        Object.assign(row, saved);
      });
    }
  }

  function comparable(value: unknown): unknown {
    return value instanceof Date ? value.getTime() : value;
  }

  function compare(left: unknown, right: unknown): number {
    const a = comparable(left) as number;
    const b = comparable(right) as number;
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    return a < b ? -1 : 1;
  }

  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected === null) return actual === null || actual === undefined;
    if (expected instanceof Date) return comparable(actual) === expected.getTime();
    if (typeof expected === "object") {
      return Object.entries(expected as Row).every(([operator, operand]) => {
        if (operator === "in") return (operand as unknown[]).includes(actual);
        if (operator === "notIn") return !(operand as unknown[]).includes(actual);
        if (operator === "not") return !matchValue(actual, operand);
        const sign = compare(actual, operand);
        if (operator === "lt") return sign < 0;
        if (operator === "lte") return sign <= 0;
        if (operator === "gt") return sign > 0;
        if (operator === "gte") return sign >= 0;
        throw new Error(`unsupported operator ${operator}`);
      });
    }
    return actual === expected;
  }

  type Resolvers = Record<string, (row: Row, expected: Row) => boolean>;

  function matchRow(row: Row, where: Row = {}, resolvers: Resolvers = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
      const resolver = resolvers[key];
      if (resolver) return resolver(row, expected as Row);
      return matchValue(row[key], expected);
    });
  }

  function sortAndTake(rows: Row[], args: Row = {}): Row[] {
    const orderBy = args.orderBy as Row | undefined;
    const sorted = [...rows];
    if (orderBy) {
      const [key, direction] = Object.entries(orderBy)[0] as [string, string];
      sorted.sort((left, right) =>
        direction === "desc" ? compare(right[key], left[key]) : compare(left[key], right[key]),
      );
    }
    const take = args.take as number | undefined;
    return take === undefined ? sorted : sorted.slice(0, take);
  }

  const serviceOf = (id: unknown) => services.find((row) => row.id === id);
  const customerOf = (id: unknown) => customers.find((row) => row.id === id);
  const staffOf = (id: unknown) => staffProfiles.find((row) => row.id === id);

  function hydrateAppointment(row: Row): Row {
    return { ...row, service: { ...(serviceOf(row.serviceId) ?? {}) } };
  }

  function hydrateSeries(row: Row, include?: Row): Row {
    const out: Row = { ...row };
    if (!include) return out;
    if (include.service) out.service = { ...(serviceOf(row.serviceId) ?? {}) };
    if (include.customer) out.customer = { ...(customerOf(row.customerId) ?? {}) };
    if (include.staff)
      out.staff = row.staffId === null ? null : { ...(staffOf(row.staffId) ?? {}) };
    if (include.appointments) {
      out.appointments = sortAndTake(
        appointments.filter((entry) => entry.seriesId === row.id),
        include.appointments as Row,
      ).map(hydrateAppointment);
    }
    return out;
  }

  function pushHistory(appointmentId: unknown, nested: Row): void {
    const stamp = tick();
    history.push({ id: `history-${sequence}`, appointmentId, createdAt: stamp, ...nested });
  }

  function applyWrite(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (key === "statusHistory") {
        const nested = (value as { create?: Row }).create;
        if (nested) pushHistory(row.id, nested);
        continue;
      }
      row[key] = value;
    }
    row.updatedAt = tick();
  }

  const appointment = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const stamp = tick();
      const row: Row = {
        id: `appointment-${sequence}`,
        staffId: null,
        seriesId: null,
        status: "pending",
        locale: "en",
        sourceChannel: "web",
        depositRequired: true,
        cancellationReason: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      for (const [key, value] of Object.entries(data)) {
        if (key === "statusHistory") continue;
        row[key] = value;
      }
      appointments.push(row);
      const nested = (data.statusHistory as { create?: Row } | undefined)?.create;
      if (nested) pushHistory(row.id, nested);
      return hydrateAppointment(row);
    }),
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        appointments.filter((row) => matchRow(row, args.where as Row)),
        args,
      ).map(hydrateAppointment),
    ),
    findFirst: vi.fn(async (args: Row = {}) => {
      const found = sortAndTake(
        appointments.filter((row) => matchRow(row, args.where as Row)),
        args,
      )[0];
      return found ? hydrateAppointment(found) : null;
    }),
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const found = appointments.find((row) => matchRow(row, where));
      return found ? hydrateAppointment(found) : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => {
      const found = appointments.find((row) => matchRow(row, where));
      if (!found) throw new Error("APPOINTMENT_RECORD_NOT_FOUND");
      return hydrateAppointment(found);
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const found = appointments.find((row) => matchRow(row, where));
      if (!found) throw new Error("APPOINTMENT_RECORD_NOT_FOUND");
      applyWrite(found, data);
      return hydrateAppointment(found);
    }),
  };

  const recurringSeries = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const stamp = tick();
      const row: Row = { id: `series-${sequence}`, createdAt: stamp, updatedAt: stamp, ...data };
      seriesRows.push(row);
      return { ...row };
    }),
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        seriesRows.filter((row) => matchRow(row, args.where as Row)),
        args,
      ).map((row) => hydrateSeries(row, args.include as Row | undefined)),
    ),
    findUnique: vi.fn(async (args: { where: Row; include?: Row }) => {
      const found = seriesRows.find((row) => matchRow(row, args.where));
      return found ? hydrateSeries(found, args.include) : null;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const found = seriesRows.find((row) => matchRow(row, where));
      if (!found) throw new Error("SERIES_RECORD_NOT_FOUND");
      applyWrite(found, data);
      return { ...found };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const targets = seriesRows.filter((row) => matchRow(row, where));
      for (const row of targets) applyWrite(row, data);
      return { count: targets.length };
    }),
  };

  const staffRelation: Resolvers = {
    staff: (row, expected) => {
      const linked = staffOf(row.staffId);
      return linked !== undefined && matchRow(linked, expected);
    },
  };

  const staffService = {
    findMany: vi.fn(async (args: Row = {}) =>
      sortAndTake(
        staffServices.filter((row) => matchRow(row, args.where as Row, staffRelation)),
        args,
      ).map((row) => ({ ...row })),
    ),
    findFirst: vi.fn(async (args: Row = {}) => {
      const found = staffServices.find((row) => matchRow(row, args.where as Row, staffRelation));
      return found ? { ...found } : null;
    }),
  };

  const delegates = {
    appointment,
    recurringSeries,
    staffService,
    businessHours: {
      findMany: vi.fn(async (args: Row = {}) =>
        businessHours.filter((row) => matchRow(row, args.where as Row)).map((row) => ({ ...row })),
      ),
    },
    staffAvailabilityRule: {
      findMany: vi.fn(async (args: Row = {}) =>
        availabilityRules
          .filter((row) => matchRow(row, args.where as Row))
          .map((row) => ({ ...row })),
      ),
    },
    staffTimeOff: {
      findMany: vi.fn(async (args: Row = {}) =>
        timeOffs.filter((row) => matchRow(row, args.where as Row)).map((row) => ({ ...row })),
      ),
    },
    service: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        const found = services.find((row) => matchRow(row, where));
        return found ? { ...found } : null;
      }),
      aggregate: vi.fn(async () => ({
        _max: {
          durationMin: services.reduce(
            (max, row) => Math.max(max, (row.durationMin as number) ?? 0),
            0,
          ),
          bufferAfterMin: services.reduce(
            (max, row) => Math.max(max, (row.bufferAfterMin as number) ?? 0),
            0,
          ),
        },
      })),
    },
    customer: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        const found = customers.find((row) => matchRow(row, where));
        return found ? { ...found } : null;
      }),
    },
  };

  return {
    db: {
      ...delegates,
      services,
      customers,
      staffProfiles,
      staffServices,
      businessHours: Object.assign(delegates.businessHours, { rows: businessHours }),
      availabilityRules,
      timeOffs,
      appointments,
      seriesRows,
      history,
      transactionOptions,
      /**
       * A walk-in booked by the receptionist in the window between the scheduler
       * planning a slot and committing it. Fires once, at the start of the next
       * transaction, which is exactly where that race lands.
       */
      beforeNextTransaction(run: () => void) {
        beforeTransaction = run;
      },
      // Read Committed on a single row behaves like this from the caller's side: the
      // conditional UPDATE of the loser runs after the winner committed and matches
      // nothing. Running the callbacks one at a time reproduces exactly that.
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>, options?: unknown) => {
        transactionOptions.push(options);
        const settled = queue.then(async () => {
          const hook = beforeTransaction;
          beforeTransaction = null;
          if (hook) hook();
          const undo = snapshot();
          try {
            return await run(delegates);
          } catch (error) {
            rollback(undo);
            throw error;
          }
        });
        queue = settled.catch(() => undefined);
        return settled;
      }),
      reset() {
        for (const table of dataTables) table.length = 0;
        transactionOptions.length = 0;
        sequence = 0;
        queue = Promise.resolve();
        beforeTransaction = null;
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

  prisma: {
    appointment: db.appointment,
    recurringSeries: db.recurringSeries,
    staffService: db.staffService,
    businessHours: db.businessHours,
    staffAvailabilityRule: db.staffAvailabilityRule,
    staffTimeOff: db.staffTimeOff,
    service: db.service,
    customer: db.customer,
    $transaction: db.$transaction,
  },
}));

import {
  MATERIALISE_HORIZON_DAYS,
  MAX_SERIES_HORIZON_DAYS,
  MAX_SERIES_INTERVAL_WEEKS,
  MAX_SERIES_OCCURRENCES,
  RecurringService,
  SERIES_MATERIALISATION_FAILED,
  SERIES_SLOT_STEP_MIN,
  SERIES_SLOT_TOLERANCE_MIN,
  addSalonWeeks,
  previewOccurrences,
  salonWallMinutes,
  toleranceOffsets,
} from "./recurring-service";
import {
  endOfSalonDay,
  formatInSalonZone,
  parseSalonDay,
  salonDayKey,
  salonDayOfWeek,
  startOfSalonDay,
  zonedMinutesToUtc,
} from "./time";

const HOST_ZONES = ["UTC", "Europe/Rome", "Pacific/Auckland"];
const originalHostZone = process.env.TZ;

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

const SERVICE_ID = "service-cut";
const CUSTOMER_ID = "customer-1";
const STAFF_A = "staff-anna";
const STAFF_B = "staff-bruno";

const DURATION_MIN = 60;
const BUFFER_MIN = 15;
const OPEN_MIN = 8 * 60;
const CLOSE_MIN = 19 * 60;
const TEN_AM = 10 * 60;

/** Monday 2026-01-12, 09:00 salon local (CET). */
const NOW = new Date("2026-01-12T08:00:00.000Z");

function at(dayKey: string, minutes: number): Date {
  return zonedMinutesToUtc(parseSalonDay(dayKey), minutes);
}

/** Tuesday 2026-01-13 at 10:00 salon local. */
const FIRST_AT = at("2026-01-13", TEN_AM);

function wall(instant: Date): string {
  return formatInSalonZone(instant, "en", { hour: "2-digit", minute: "2-digit" });
}

function isoList(instants: (Date | undefined)[]): string[] {
  return instants.map((instant) => (instant as Date).toISOString());
}

function withHostTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  return run();
}

function seedSalon(
  options: {
    staffIds?: string[];
    openMin?: number;
    closeMin?: number;
    businessOpenMin?: number;
    businessCloseMin?: number;
    closedDays?: number[];
  } = {},
): void {
  const staffIds = options.staffIds ?? [STAFF_A];
  const openMin = options.openMin ?? OPEN_MIN;
  const closeMin = options.closeMin ?? CLOSE_MIN;
  const businessOpenMin = options.businessOpenMin ?? openMin;
  const businessCloseMin = options.businessCloseMin ?? closeMin;
  const closedDays = options.closedDays ?? [];

  db.services.push({
    id: SERVICE_ID,
    slug: "cut",
    durationMin: DURATION_MIN,
    bufferAfterMin: BUFFER_MIN,
    isActive: true,
  });
  db.customers.push({ id: CUSTOMER_ID, deletedAt: null, anonymizedAt: null });

  for (const staffId of staffIds) {
    db.staffProfiles.push({ id: staffId, isBookable: true, displayName: staffId });
    db.staffServices.push({ id: `link-${staffId}`, staffId, serviceId: SERVICE_ID });
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      db.availabilityRules.push({
        id: `rule-${staffId}-${dayOfWeek}`,
        staffId,
        dayOfWeek,
        startMin: openMin,
        endMin: closeMin,
      });
    }
  }
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    db.businessHours.rows.push({
      id: `hours-${dayOfWeek}`,
      dayOfWeek,
      startMin: businessOpenMin,
      endMin: businessCloseMin,
      isOpen: !closedDays.includes(dayOfWeek),
    });
  }
}

function seedSeries(overrides: Row = {}): Row {
  const row: Row = {
    id: `series-${db.seriesRows.length + 1}`,
    customerId: CUSTOMER_ID,
    serviceId: SERVICE_ID,
    staffId: null,
    intervalWeeks: 6,
    nextAt: FIRST_AT,
    endsAt: null,
    active: true,
    locale: "de",
    channel: "web",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  db.seriesRows.push(row);
  return row;
}

function seedAppointment(overrides: Row = {}): Row {
  const row: Row = {
    id: `seed-appointment-${db.appointments.length + 1}`,
    customerId: "walk-in-customer",
    serviceId: SERVICE_ID,
    staffId: STAFF_A,
    seriesId: null,
    status: "confirmed",
    locale: "de",
    sourceChannel: "web",
    depositRequired: false,
    cancellationReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  db.appointments.push(row);
  return row;
}

function seedFullDayTimeOff(staffId: string, dayKey: string): void {
  const anchor = parseSalonDay(dayKey);
  db.timeOffs.push({
    id: `time-off-${dayKey}-${staffId}`,
    staffId,
    startsAt: startOfSalonDay(anchor),
    endsAt: endOfSalonDay(anchor),
    reason: "holiday",
  });
}

function service(): RecurringService {
  return new RecurringService();
}

const pristineCreate = db.appointment.create.getMockImplementation() as (args: Row) => Promise<Row>;

/** A connection that drops on the nth booking of the run, which is what a cron meets. */
function breakCreateOnCall(nth: number, message: string): void {
  let calls = 0;
  db.appointment.create.mockImplementation(async (args: Row) => {
    calls += 1;
    if (calls === nth) throw Object.assign(new Error(message), { code: "P1017" });
    return pristineCreate(args);
  });
}

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  db.appointment.create.mockImplementation(pristineCreate as never);
});

afterEach(() => {
  if (originalHostZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalHostZone;
});

describe("salonWallMinutes", () => {
  it("reads the wall clock, not the offset from salon midnight", () => {
    expect(salonWallMinutes(at("2026-01-13", TEN_AM))).toBe(600);
    expect(salonWallMinutes(at("2026-07-14", TEN_AM))).toBe(600);
    expect(salonWallMinutes(at("2026-10-25", TEN_AM))).toBe(600);
    expect(salonWallMinutes(at("2026-03-29", TEN_AM))).toBe(600);
    expect(salonWallMinutes(at("2026-01-13", 0))).toBe(0);
    expect(salonWallMinutes(at("2026-01-13", 1_439))).toBe(1_439);
  });

  it("is not the naive difference from the start of the salon day on a 25 hour day", () => {
    const occurrence = at("2026-10-25", TEN_AM);
    const naive = (occurrence.getTime() - startOfSalonDay(occurrence).getTime()) / MS_PER_MINUTE;
    expect(naive).toBe(660);
    expect(salonWallMinutes(occurrence)).toBe(600);
  });

  it("is independent of the host timezone", () => {
    const occurrence = at("2026-08-11", TEN_AM);
    for (const hostZone of HOST_ZONES) {
      expect(withHostTimeZone(hostZone, () => salonWallMinutes(occurrence))).toBe(600);
    }
  });
});

describe("addSalonWeeks across both Europe/Rome DST transitions", () => {
  it("keeps a six-weekly 10:00 occurrence at 10:00 salon local for a full year", () => {
    const expected = [
      "2026-01-13",
      "2026-02-24",
      "2026-04-07",
      "2026-05-19",
      "2026-06-30",
      "2026-08-11",
      "2026-09-22",
      "2026-11-03",
      "2026-12-15",
      "2027-01-26",
    ];
    const occurrences = previewOccurrences(FIRST_AT, 6, expected.length);

    expect(occurrences.map((entry) => salonDayKey(entry))).toEqual(expected);
    for (const occurrence of occurrences) {
      expect(wall(occurrence)).toBe("10:00");
      expect(salonDayOfWeek(occurrence)).toBe(2);
    }
  });

  it("keeps a weekly 10:00 occurrence at 10:00 for 53 consecutive weeks", () => {
    const occurrences = previewOccurrences(FIRST_AT, 1, 53);
    expect(occurrences).toHaveLength(53);
    expect(new Set(occurrences.map((entry) => entry.getTime())).size).toBe(53);
    for (const occurrence of occurrences) {
      expect(wall(occurrence)).toBe("10:00");
      expect(salonDayOfWeek(occurrence)).toBe(2);
    }
    expect(salonDayKey(occurrences[52] as Date)).toBe("2027-01-12");
  });

  it("documents the millisecond arithmetic it replaces, which drifts by an hour", () => {
    const naive = new Date(FIRST_AT.getTime() + 12 * 7 * MS_PER_DAY);
    const correct = addSalonWeeks(FIRST_AT, 12);

    expect(salonDayKey(naive)).toBe(salonDayKey(correct));
    expect(wall(naive)).toBe("11:00");
    expect(wall(correct)).toBe("10:00");
    expect(correct.getTime()).toBe(naive.getTime() - 3_600_000);
  });

  it("steps across spring forward and fall back one week at a time", () => {
    const beforeSpring = at("2026-03-24", TEN_AM);
    expect(beforeSpring.toISOString()).toBe("2026-03-24T09:00:00.000Z");
    expect(addSalonWeeks(beforeSpring, 1).toISOString()).toBe("2026-03-31T08:00:00.000Z");

    const beforeAutumn = at("2026-10-20", TEN_AM);
    expect(beforeAutumn.toISOString()).toBe("2026-10-20T08:00:00.000Z");
    expect(addSalonWeeks(beforeAutumn, 1).toISOString()).toBe("2026-10-27T09:00:00.000Z");
  });

  it("does not accumulate: nine six-week advances land exactly 378 days later", () => {
    let cursor = FIRST_AT;
    for (let step = 0; step < 9; step += 1) cursor = addSalonWeeks(cursor, 6);
    expect(cursor.getTime()).toBe(addSalonWeeks(FIRST_AT, 54).getTime());
    expect(salonDayKey(cursor)).toBe("2027-01-26");
    expect(wall(cursor)).toBe("10:00");
  });

  it("produces the same instants under every host timezone", () => {
    const rendered = HOST_ZONES.map((hostZone) =>
      withHostTimeZone(hostZone, () =>
        previewOccurrences(FIRST_AT, 6, 10)
          .map((entry) => entry.toISOString())
          .join("|"),
      ),
    );
    expect(new Set(rendered).size).toBe(1);
    expect(rendered[0]).toContain("2026-04-07T08:00:00.000Z");
    expect(rendered[0]).toContain("2026-11-03T09:00:00.000Z");
  });

  it("keeps an 08:00 opening-time series at 08:00 and a 18:30 one at 18:30", () => {
    for (const minutes of [OPEN_MIN, 18 * 60 + 30]) {
      const start = at("2026-02-17", minutes);
      for (let step = 0, cursor = start; step < 12; step += 1) {
        cursor = addSalonWeeks(cursor, 4);
        expect(salonWallMinutes(cursor)).toBe(minutes);
      }
    }
  });
});

describe("previewOccurrences", () => {
  it("stops at the end date without emitting anything past it", () => {
    const endsAt = endOfSalonDay(at("2026-04-07", TEN_AM));
    const occurrences = previewOccurrences(FIRST_AT, 6, 10, endsAt);
    expect(occurrences.map((entry) => salonDayKey(entry))).toEqual([
      "2026-01-13",
      "2026-02-24",
      "2026-04-07",
    ]);
  });

  it("treats a null end date as open ended and honours the count", () => {
    expect(previewOccurrences(FIRST_AT, 6, 4, null)).toHaveLength(4);
    expect(previewOccurrences(FIRST_AT, 6, 0)).toEqual([]);
  });

  it("rejects an interval that is not a whole number of weeks", () => {
    expect(() => previewOccurrences(FIRST_AT, 0, 3)).toThrow("INVALID_INTERVAL");
    expect(() => previewOccurrences(FIRST_AT, -1, 3)).toThrow("INVALID_INTERVAL");
    expect(() => previewOccurrences(FIRST_AT, 1.5, 3)).toThrow("INVALID_INTERVAL");
  });
});

describe("toleranceOffsets", () => {
  it("searches nearest first and prefers the later slot on a tie", () => {
    const offsets = toleranceOffsets();
    expect(offsets.slice(0, 7)).toEqual([0, 15, -15, 30, -30, 45, -45]);
    expect(offsets).toHaveLength(1 + (2 * SERIES_SLOT_TOLERANCE_MIN) / SERIES_SLOT_STEP_MIN);
    for (let index = 1; index < offsets.length; index += 2) {
      expect(offsets[index]).toBeGreaterThan(0);
      expect(offsets[index + 1]).toBe(-(offsets[index] as number));
    }
  });

  it("never leaves the tolerance window and never repeats", () => {
    const offsets = toleranceOffsets();
    expect(new Set(offsets).size).toBe(offsets.length);
    for (const offset of offsets) {
      expect(Math.abs(offset)).toBeLessThanOrEqual(SERIES_SLOT_TOLERANCE_MIN);
      expect(Math.abs(offset) % SERIES_SLOT_STEP_MIN).toBe(0);
    }
    expect(Math.max(...offsets.map(Math.abs))).toBe(SERIES_SLOT_TOLERANCE_MIN);
  });
});

describe("materialiseDue", () => {
  const HORIZON = new Date(FIRST_AT.getTime() + MS_PER_DAY);

  it("books the occurrence on the exact slot the cadence asked for", async () => {
    seedSalon();
    const series = seedSeries();

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.seriesConsidered).toBe(1);
    expect(report.booked).toBe(1);
    expect(report.moved).toBe(0);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({
      seriesId: series.id,
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      locale: "de",
      status: "booked",
      staffId: STAFF_A,
      offsetMinutes: 0,
    });
    expect(report.outcomes[0].occurrenceAt).toEqual(FIRST_AT);

    expect(db.appointments).toHaveLength(1);
    expect(db.appointments[0]).toMatchObject({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      staffId: STAFF_A,
      seriesId: series.id,
      status: "confirmed",
      locale: "de",
      sourceChannel: "web",
      depositRequired: false,
    });
    expect(wall(db.appointments[0].startsAt as Date)).toBe("10:00");
    expect(db.appointments[0].endsAt).toEqual(new Date(FIRST_AT.getTime() + 60 * MS_PER_MINUTE));
    expect(db.history).toHaveLength(1);
    expect(db.history[0]).toMatchObject({ status: "confirmed" });
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });

  it("commits the cursor move and the booking in one serializable transaction", async () => {
    seedSalon();
    seedSeries();
    await service().materialiseDue(NOW, HORIZON);
    expect(db.transactionOptions).toHaveLength(1);
    expect(db.transactionOptions[0]).toMatchObject({ isolationLevel: "Serializable" });
  });

  it("rejects a horizon that is not in the future", async () => {
    await expect(service().materialiseDue(NOW, NOW)).rejects.toThrow("INVALID_HORIZON");
    await expect(service().materialiseDue(NOW, new Date(NOW.getTime() - 1))).rejects.toThrow(
      "INVALID_HORIZON",
    );
  });

  it("defaults the horizon to the materialisation window", async () => {
    seedSalon();
    seedSeries();
    const report = await service().materialiseDue(NOW);
    expect(report.horizon.getTime()).toBe(NOW.getTime() + MATERIALISE_HORIZON_DAYS * MS_PER_DAY);
  });

  it("ignores a paused series", async () => {
    seedSalon();
    seedSeries({ active: false });
    const report = await service().materialiseDue(NOW, HORIZON);
    expect(report.seriesConsidered).toBe(0);
    expect(db.appointments).toHaveLength(0);
  });

  it("stops at MAX_OCCURRENCES_PER_RUN instead of materialising a whole year at once", async () => {
    seedSalon();
    seedSeries({ intervalWeeks: 1 });
    const report = await service().materialiseDue(NOW, new Date(NOW.getTime() + 200 * MS_PER_DAY));
    expect(report.outcomes).toHaveLength(12);
    expect(db.appointments).toHaveLength(12);
  });
});

describe("idempotency", () => {
  const HORIZON = new Date(FIRST_AT.getTime() + MS_PER_DAY);

  it("creates one appointment per occurrence when the cron runs twice", async () => {
    seedSalon();
    seedSeries();

    const first = await service().materialiseDue(NOW, HORIZON);
    const second = await service().materialiseDue(NOW, HORIZON);

    expect(first.booked).toBe(1);
    expect(second.seriesConsidered).toBe(0);
    expect(second.outcomes).toEqual([]);
    expect(db.appointments).toHaveLength(1);
    expect(db.history).toHaveLength(1);
  });

  it("creates one appointment per occurrence over a whole materialisation window", async () => {
    seedSalon();
    seedSeries({ intervalWeeks: 1 });

    await service().materialiseDue(NOW);
    const bookedFirstRun = db.appointments.length;
    await service().materialiseDue(NOW);

    expect(bookedFirstRun).toBeGreaterThan(1);
    expect(db.appointments).toHaveLength(bookedFirstRun);
    expect(
      new Set(db.appointments.map((row) => (row.startsAt as Date).getTime()).values()).size,
    ).toBe(bookedFirstRun);
  });

  it("refuses to book twice when someone resets the cursor by hand", async () => {
    seedSalon();
    const series = seedSeries();

    const first = await service().materialiseDue(NOW, HORIZON);
    series.nextAt = FIRST_AT;
    const second = await service().materialiseDue(NOW, HORIZON);

    expect(second.outcomes).toHaveLength(1);
    expect(second.outcomes[0]).toMatchObject({
      status: "already_booked",
      appointmentId: first.outcomes[0].appointmentId,
    });
    expect(db.appointments).toHaveLength(1);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });

  it("survives two schedulers racing on the same series", async () => {
    seedSalon();
    const series = seedSeries();

    const [first, second] = await Promise.all([
      service().materialiseDue(NOW, HORIZON),
      service().materialiseDue(NOW, HORIZON),
    ]);

    expect(first.booked + second.booked).toBe(1);
    expect(first.outcomes.length + second.outcomes.length).toBe(1);
    expect(db.appointments).toHaveLength(1);
    expect(db.history).toHaveLength(1);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });
});

describe("never double-books a staff member", () => {
  const HORIZON = new Date(FIRST_AT.getTime() + MS_PER_DAY);

  it("declines the occurrence when the only slot on that day is taken", async () => {
    seedSalon({ openMin: TEN_AM, closeMin: TEN_AM + DURATION_MIN + BUFFER_MIN });
    const series = seedSeries();
    seedAppointment({
      startsAt: FIRST_AT,
      endsAt: new Date(FIRST_AT.getTime() + DURATION_MIN * MS_PER_MINUTE),
    });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.booked).toBe(0);
    expect(report.needsAttention).toBe(1);
    expect(report.outcomes[0]).toMatchObject({
      status: "needs_attention",
      reason: "NO_SLOT_WITHIN_TOLERANCE",
    });
    expect(db.appointments).toHaveLength(1);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });

  it("declines when the staff member is on leave for the whole day", async () => {
    seedSalon();
    seedSeries();
    seedFullDayTimeOff(STAFF_A, "2026-01-13");

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({
      status: "needs_attention",
      reason: "NO_SLOT_WITHIN_TOLERANCE",
    });
    expect(db.appointments).toHaveLength(0);
  });

  it("declines an occurrence that falls on a day the salon is shut", async () => {
    seedSalon({ closedDays: [salonDayOfWeek(FIRST_AT)] });
    seedSeries();

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({
      status: "needs_attention",
      reason: "NO_SLOT_WITHIN_TOLERANCE",
    });
    expect(db.appointments).toHaveLength(0);
  });

  it("will not run past closing time even when the rota says the staff member is there", async () => {
    seedSalon({ businessCloseMin: 11 * 60 });
    seedSeries();

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({ status: "moved", offsetMinutes: -15 });
    expect(report.outcomes[0].startsAt).toEqual(at("2026-01-13", TEN_AM - 15));
    const booked = db.appointments[0];
    expect(salonWallMinutes(booked.endsAt as Date) + BUFFER_MIN).toBeLessThanOrEqual(11 * 60);
  });

  it("declines when nobody is trained on the service", async () => {
    seedSalon();
    db.staffServices.length = 0;

    seedSeries();
    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({
      status: "needs_attention",
      reason: "STAFF_NOT_ELIGIBLE",
    });
    expect(db.appointments).toHaveLength(0);
  });

  it("declines when the named staff member is no longer bookable", async () => {
    seedSalon();
    (db.staffProfiles[0] as Row).isBookable = false;
    seedSeries({ staffId: STAFF_A });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({ reason: "STAFF_NOT_ELIGIBLE" });
    expect(db.appointments).toHaveLength(0);
  });

  it("respects the clean-up buffer of the appointment already in the book", async () => {
    seedSalon();
    seedSeries();
    seedAppointment({
      startsAt: at("2026-01-13", TEN_AM - DURATION_MIN),
      endsAt: at("2026-01-13", TEN_AM),
    });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({ status: "moved" });
    expect(report.outcomes[0].startsAt).toEqual(at("2026-01-13", TEN_AM + BUFFER_MIN));
  });

  it("loses the race with a walk-in booked between planning and committing", async () => {
    seedSalon();
    const series = seedSeries();
    db.beforeNextTransaction(() => {
      seedAppointment({
        id: "walk-in",
        startsAt: FIRST_AT,
        endsAt: new Date(FIRST_AT.getTime() + DURATION_MIN * MS_PER_MINUTE),
      });
    });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({
      status: "needs_attention",
      reason: "SLOT_TAKEN_WHILE_BOOKING",
    });
    expect(db.appointments.map((row) => row.id)).toEqual(["walk-in"]);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });
});

describe("tolerance search", () => {
  const HORIZON = new Date(FIRST_AT.getTime() + MS_PER_DAY);

  async function bookAgainstBlockedIdealSlot() {
    seedSalon();
    seedSeries();
    seedAppointment({
      startsAt: FIRST_AT,
      endsAt: new Date(FIRST_AT.getTime() + DURATION_MIN * MS_PER_MINUTE),
    });
    return service().materialiseDue(NOW, HORIZON);
  }

  it("moves to the nearest free slot on the same day and reports the offset", async () => {
    const report = await bookAgainstBlockedIdealSlot();
    const outcome = report.outcomes[0];

    expect(report.moved).toBe(1);
    expect(outcome.status).toBe("moved");
    expect(outcome.offsetMinutes).toBe(75);
    expect(Math.abs(outcome.offsetMinutes as number)).toBeLessThanOrEqual(
      SERIES_SLOT_TOLERANCE_MIN,
    );
    expect(outcome.startsAt).toEqual(at("2026-01-13", TEN_AM + 75));
    expect(salonDayKey(outcome.startsAt as Date)).toBe(salonDayKey(FIRST_AT));
    expect(outcome.occurrenceAt).toEqual(FIRST_AT);
  });

  it("is deterministic: the same book produces the same alternative every run", async () => {
    const first = await bookAgainstBlockedIdealSlot();
    db.reset();
    const second = await bookAgainstBlockedIdealSlot();

    expect(second.outcomes[0].offsetMinutes).toBe(first.outcomes[0].offsetMinutes);
    expect(isoList([second.outcomes[0].startsAt])).toEqual(isoList([first.outcomes[0].startsAt]));
  });

  it("never moves the occurrence onto another salon day", async () => {
    seedSalon({ openMin: TEN_AM, closeMin: 23 * 60 });
    seedSeries();
    seedAppointment({
      startsAt: FIRST_AT,
      endsAt: at("2026-01-13", TEN_AM + SERIES_SLOT_TOLERANCE_MIN + DURATION_MIN),
    });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({
      status: "needs_attention",
      reason: "NO_SLOT_WITHIN_TOLERANCE",
    });
  });

  it("prefers the exact time with a colleague over a shifted time with the usual one", async () => {
    seedSalon({ staffIds: [STAFF_A, STAFF_B] });
    seedSeries();
    seedAppointment({
      staffId: STAFF_A,
      startsAt: FIRST_AT,
      endsAt: new Date(FIRST_AT.getTime() + DURATION_MIN * MS_PER_MINUTE),
    });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({
      status: "booked",
      staffId: STAFF_B,
      offsetMinutes: 0,
    });
  });

  it("keeps a named staff member even when a colleague is free at the same time", async () => {
    seedSalon({ staffIds: [STAFF_A, STAFF_B] });
    seedSeries({ staffId: STAFF_B });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({ staffId: STAFF_B, offsetMinutes: 0 });
  });

  it("keeps continuity with whoever did the previous occurrence in the series", async () => {
    seedSalon({ staffIds: [STAFF_A, STAFF_B] });
    const series = seedSeries();
    seedAppointment({
      id: "previous-occurrence",
      staffId: STAFF_B,
      seriesId: series.id,
      startsAt: at("2025-12-02", TEN_AM),
      endsAt: at("2025-12-02", TEN_AM + DURATION_MIN),
    });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({ staffId: STAFF_B, offsetMinutes: 0 });
  });
});

describe("cursor advances without drift", () => {
  it("matches previewOccurrences exactly across a skipped and a failed occurrence", async () => {
    seedSalon();
    const start = at("2026-01-06", TEN_AM);
    const series = seedSeries({ intervalWeeks: 1, nextAt: start });
    seedFullDayTimeOff(STAFF_A, "2026-01-20");

    const report = await service().materialiseDue(NOW, at("2026-02-11", 0));

    const expected = previewOccurrences(start, 1, 6);
    expect(isoList(report.outcomes.map((entry) => entry.occurrenceAt))).toEqual(isoList(expected));
    expect(report.outcomes.map((entry) => entry.status)).toEqual([
      "skipped_past",
      "booked",
      "needs_attention",
      "booked",
      "booked",
      "booked",
    ]);
    expect(report.outcomes[0].reason).toBe("OCCURRENCE_IN_PAST");
    expect(report.outcomes[2].reason).toBe("NO_SLOT_WITHIN_TOLERANCE");

    expect(series.nextAt).toEqual(addSalonWeeks(start, 6));
    expect(db.appointments.map((row) => salonDayKey(row.startsAt as Date))).toEqual([
      "2026-01-13",
      "2026-01-27",
      "2026-02-03",
      "2026-02-10",
    ]);
    for (const row of db.appointments) expect(wall(row.startsAt as Date)).toBe("10:00");
  });

  it("materialises a whole year of six-weekly occurrences at 10:00 without drifting", async () => {
    seedSalon();
    const expected = previewOccurrences(FIRST_AT, 6, 10);
    const series = seedSeries({
      endsAt: endOfSalonDay(expected[expected.length - 1] as Date),
    });

    const booked: Date[] = [];
    let completed = 0;
    for (let week = 0; week < 62; week += 1) {
      const runAt = new Date(NOW.getTime() + week * 7 * MS_PER_DAY);
      const report = await service().materialiseDue(runAt);
      for (const outcome of report.outcomes) {
        if (outcome.status === "booked") booked.push(outcome.occurrenceAt);
        if (outcome.status === "series_completed") completed += 1;
      }
      expect(report.moved).toBe(0);
      expect(report.needsAttention).toBe(0);
    }

    expect(isoList(booked)).toEqual(isoList(expected));
    expect(db.appointments).toHaveLength(10);
    for (const row of db.appointments) {
      expect(wall(row.startsAt as Date)).toBe("10:00");
      expect(salonDayOfWeek(row.startsAt as Date)).toBe(2);
    }
    expect(completed).toBe(1);
    expect(series.active).toBe(false);
  });
});

describe("series lifecycle", () => {
  it("skipNext consumes exactly one interval and keeps the wall clock", async () => {
    const series = seedSeries({ intervalWeeks: 1, nextAt: at("2026-03-24", TEN_AM) });

    const result = await service().skipNext(series.id as string, "customer away");

    expect(result.nextAt).toEqual(at("2026-03-31", TEN_AM));
    expect(result.nextAt.toISOString()).toBe("2026-03-31T08:00:00.000Z");
    expect(wall(result.nextAt)).toBe("10:00");
    expect(result.active).toBe(true);
    expect(result.reason).toBe("customer away");
    expect(series.nextAt).toEqual(result.nextAt);
  });

  it("skipNext does not slide the series by whatever the pause happened to last", async () => {
    const series = seedSeries({ intervalWeeks: 6 });
    await service().skipNext(series.id as string);
    await service().skipNext(series.id as string);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 12));
    expect(salonDayOfWeek(series.nextAt as Date)).toBe(2);
  });

  it("skipNext closes a series whose last occurrence was the one skipped", async () => {
    const last = addSalonWeeks(FIRST_AT, 6);
    const series = seedSeries({ nextAt: last, endsAt: endOfSalonDay(last) });

    const result = await service().skipNext(series.id as string);

    expect(result.active).toBe(false);
    expect(series.active).toBe(false);
  });

  it("skipNext refuses an unknown series", async () => {
    await expect(service().skipNext("nope")).rejects.toThrow("SERIES_NOT_FOUND");
  });

  it("pause stops generation and leaves the cursor exactly where it was", async () => {
    seedSalon();
    const series = seedSeries();

    const result = await service().pause(series.id as string);

    expect(result.active).toBe(false);
    expect(result.nextAt).toEqual(FIRST_AT);
    const report = await service().materialiseDue(NOW, new Date(FIRST_AT.getTime() + MS_PER_DAY));
    expect(report.seriesConsidered).toBe(0);
    expect(db.appointments).toHaveLength(0);
  });

  it("resume comes back on the original phase, not on the day resume was clicked", async () => {
    const series = seedSeries({ active: false });
    const resumedAt = new Date("2026-06-01T08:00:00.000Z");

    const result = await service().resume(series.id as string, resumedAt);

    expect(result.active).toBe(true);
    expect(result.nextAt).toEqual(at("2026-06-30", TEN_AM));
    expect(wall(result.nextAt)).toBe("10:00");
    expect(salonDayOfWeek(result.nextAt)).toBe(2);
    expect(previewOccurrences(FIRST_AT, 6, 10).map((entry) => entry.getTime())).toContain(
      result.nextAt.getTime(),
    );
    expect(series.active).toBe(true);
  });

  it("resume closes a series whose end date passed while it was paused", async () => {
    const series = seedSeries({ active: false, endsAt: endOfSalonDay(at("2026-03-01", TEN_AM)) });

    const result = await service().resume(
      series.id as string,
      new Date("2026-06-01T08:00:00.000Z"),
    );

    expect(result).toMatchObject({ active: false, reason: "SERIES_END_REACHED" });
    expect(series.active).toBe(false);
  });

  it("resume refuses a series that is too stale to catch up", async () => {
    const series = seedSeries({
      active: false,
      intervalWeeks: 1,
      nextAt: at("2015-01-06", TEN_AM),
    });
    await expect(service().resume(series.id as string, NOW)).rejects.toThrow("SERIES_TOO_STALE");
    expect(series.nextAt).toEqual(at("2015-01-06", TEN_AM));
  });

  it("endSeries never touches appointments already in the book", async () => {
    const series = seedSeries();
    const past = seedAppointment({
      id: "past",
      seriesId: series.id,
      startsAt: at("2025-11-04", TEN_AM),
      endsAt: at("2025-11-04", TEN_AM + DURATION_MIN),
      status: "completed",
    });
    const pastNeverClosed = seedAppointment({
      id: "past-still-confirmed",
      seriesId: series.id,
      startsAt: at("2025-12-16", TEN_AM),
      endsAt: at("2025-12-16", TEN_AM + DURATION_MIN),
      status: "confirmed",
    });
    const future = seedAppointment({
      id: "future",
      seriesId: series.id,
      startsAt: FIRST_AT,
      endsAt: new Date(FIRST_AT.getTime() + DURATION_MIN * MS_PER_MINUTE),
    });

    const result = await service().endSeries(series.id as string, { at: NOW });

    expect(result.active).toBe(false);
    expect(result.endsAt).toEqual(NOW);
    expect(result.cancelledAppointmentIds).toEqual([]);
    expect(db.appointments).toHaveLength(3);
    expect(past.status).toBe("completed");
    expect(pastNeverClosed.status).toBe("confirmed");
    expect(future.status).toBe("confirmed");
    expect(db.history).toHaveLength(0);
  });

  it("endSeries releases only future slots when asked, and deletes nothing", async () => {
    const series = seedSeries();
    const past = seedAppointment({
      id: "past",
      seriesId: series.id,
      startsAt: at("2025-11-04", TEN_AM),
      endsAt: at("2025-11-04", TEN_AM + DURATION_MIN),
      status: "completed",
    });
    // A visit that happened and was never ticked off. Still "confirmed", still the past.
    const pastNeverClosed = seedAppointment({
      id: "past-still-confirmed",
      seriesId: series.id,
      startsAt: at("2025-12-16", TEN_AM),
      endsAt: at("2025-12-16", TEN_AM + DURATION_MIN),
      status: "confirmed",
    });
    const cancelledAlready = seedAppointment({
      id: "already-cancelled",
      seriesId: series.id,
      startsAt: addSalonWeeks(FIRST_AT, 6),
      endsAt: new Date(addSalonWeeks(FIRST_AT, 6).getTime() + DURATION_MIN * MS_PER_MINUTE),
      status: "cancelled",
    });
    const future = seedAppointment({
      id: "future",
      seriesId: series.id,
      startsAt: FIRST_AT,
      endsAt: new Date(FIRST_AT.getTime() + DURATION_MIN * MS_PER_MINUTE),
    });

    const result = await service().endSeries(series.id as string, {
      at: NOW,
      cancelFutureAppointments: true,
      reason: "customer moved away",
    });

    expect(result.cancelledAppointmentIds).toEqual(["future"]);
    expect(future.status).toBe("cancelled");
    expect(future.cancellationReason).toBe("customer moved away");
    expect(past.status).toBe("completed");
    expect(pastNeverClosed.status).toBe("confirmed");
    expect(pastNeverClosed.cancellationReason).toBeNull();
    expect(cancelledAlready.status).toBe("cancelled");
    expect(db.appointments).toHaveLength(4);
    expect(db.history).toHaveLength(1);
  });

  it("endSeries stops the scheduler generating anything else", async () => {
    seedSalon();
    const series = seedSeries();
    await service().endSeries(series.id as string, { at: NOW });
    const report = await service().materialiseDue(NOW, new Date(FIRST_AT.getTime() + MS_PER_DAY));
    expect(report.seriesConsidered).toBe(0);
    expect(db.appointments).toHaveLength(0);
  });

  it("endSeries refuses an unknown series", async () => {
    await expect(service().endSeries("nope")).rejects.toThrow("SERIES_NOT_FOUND");
  });

  it("cancelling one occurrence leaves the series running", async () => {
    seedSalon();
    const series = seedSeries();
    const booked = await service().materialiseDue(NOW, new Date(FIRST_AT.getTime() + MS_PER_DAY));
    const appointmentId = booked.outcomes[0].appointmentId as string;

    await service().cancelOccurrence(appointmentId, "customer ill");

    expect(db.appointments[0].status).toBe("cancelled");
    expect(db.appointments[0].cancellationReason).toBe("customer ill");
    expect(db.appointments[0].seriesId).toBe(series.id);
    expect(series.active).toBe(true);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));

    const next = await service().materialiseDue(
      NOW,
      new Date(addSalonWeeks(FIRST_AT, 6).getTime() + MS_PER_DAY),
    );
    expect(next.booked).toBe(1);
    expect(next.outcomes[0].occurrenceAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });

  it("cancelling the same occurrence twice writes one history row", async () => {
    const series = seedSeries();
    const appointment = seedAppointment({
      id: "occurrence",
      seriesId: series.id,
      startsAt: FIRST_AT,
      endsAt: new Date(FIRST_AT.getTime() + DURATION_MIN * MS_PER_MINUTE),
    });

    await service().cancelOccurrence("occurrence", "customer ill");
    await service().cancelOccurrence("occurrence", "customer ill again");

    expect(appointment.cancellationReason).toBe("customer ill");
    expect(db.history).toHaveLength(1);
  });

  it("cancelOccurrence refuses appointments that are not part of a series", async () => {
    seedAppointment({ id: "walk-in", startsAt: FIRST_AT, endsAt: FIRST_AT });
    await expect(service().cancelOccurrence("walk-in", "no")).rejects.toThrow(
      "APPOINTMENT_NOT_IN_SERIES",
    );
    await expect(service().cancelOccurrence("missing", "no")).rejects.toThrow(
      "APPOINTMENT_NOT_FOUND",
    );
  });

  it("closes a series once the cursor passes its end date without deleting the history", async () => {
    seedSalon();
    const series = seedSeries({
      nextAt: FIRST_AT,
      endsAt: endOfSalonDay(at("2026-01-06", TEN_AM)),
    });
    seedAppointment({
      id: "historic",
      seriesId: series.id,
      startsAt: at("2026-01-06", TEN_AM),
      endsAt: at("2026-01-06", TEN_AM + DURATION_MIN),
      status: "completed",
    });

    const report = await service().materialiseDue(NOW, new Date(FIRST_AT.getTime() + MS_PER_DAY));

    expect(report.outcomes[0]).toMatchObject({
      status: "series_completed",
      reason: "SERIES_END_REACHED",
    });
    expect(series.active).toBe(false);
    expect(db.appointments).toHaveLength(1);
    expect(db.appointments[0].status).toBe("completed");
  });

  it("closes a series whose customer was deleted or anonymised", async () => {
    seedSalon();
    (db.customers[0] as Row).anonymizedAt = new Date("2026-01-10T00:00:00.000Z");
    const series = seedSeries();

    const report = await service().materialiseDue(NOW, new Date(FIRST_AT.getTime() + MS_PER_DAY));

    expect(report.outcomes[0]).toMatchObject({
      status: "series_completed",
      reason: "CUSTOMER_UNAVAILABLE",
    });
    expect(series.active).toBe(false);
    expect(db.appointments).toHaveLength(0);
  });

  it("holds a series whose service was retired without consuming the occurrence", async () => {
    seedSalon();
    (db.services[0] as Row).isActive = false;
    const series = seedSeries();

    const report = await service().materialiseDue(NOW, new Date(FIRST_AT.getTime() + MS_PER_DAY));

    expect(report.outcomes[0]).toMatchObject({
      status: "needs_attention",
      reason: "SERVICE_INACTIVE",
    });
    expect(series.active).toBe(true);
    expect(series.nextAt).toEqual(FIRST_AT);
  });
});

describe("createSeries", () => {
  function input(overrides: Row = {}): Row {
    return {
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      intervalWeeks: 6,
      firstAt: FIRST_AT,
      locale: "de",
      ...overrides,
    };
  }

  it("registers the arrangement without booking anything", async () => {
    seedSalon();
    const created = (await service().createSeries(input(), NOW)) as Row;

    expect(created).toMatchObject({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      staffId: null,
      intervalWeeks: 6,
      active: true,
      locale: "de",
      channel: "web",
      endsAt: null,
    });
    expect(created.nextAt).toEqual(FIRST_AT);
    expect(db.appointments).toHaveLength(0);
  });

  it("derives the end date from a fixed number of occurrences", async () => {
    seedSalon();
    const created = (await service().createSeries(input({ occurrences: 10 }), NOW)) as Row;
    const expected = previewOccurrences(FIRST_AT, 6, 10);

    expect(created.endsAt).toEqual(endOfSalonDay(expected[9] as Date));
    expect(previewOccurrences(FIRST_AT, 6, 20, created.endsAt as Date)).toHaveLength(10);
  });

  it("refuses a start inside the booking lead time", async () => {
    seedSalon();
    await expect(
      service().createSeries(input({ firstAt: new Date(NOW.getTime() + 60 * MS_PER_MINUTE) }), NOW),
    ).rejects.toThrow("SERIES_START_TOO_SOON");
  });

  it("refuses a start beyond MAX_SERIES_HORIZON_DAYS", async () => {
    seedSalon();
    const beyond = new Date(NOW.getTime() + MAX_SERIES_HORIZON_DAYS * MS_PER_DAY);
    await expect(service().createSeries(input({ firstAt: beyond }), NOW)).rejects.toThrow(
      "SERIES_START_TOO_FAR_AHEAD",
    );
    await expect(
      service().createSeries(input({ firstAt: new Date(beyond.getTime() - MS_PER_DAY) }), NOW),
    ).resolves.toMatchObject({ active: true });
  });

  it("refuses an end date beyond MAX_SERIES_HORIZON_DAYS or before the start", async () => {
    seedSalon();
    await expect(
      service().createSeries(
        input({ endsAt: new Date(NOW.getTime() + (MAX_SERIES_HORIZON_DAYS + 1) * MS_PER_DAY) }),
        NOW,
      ),
    ).rejects.toThrow("SERIES_END_TOO_FAR_AHEAD");
    await expect(
      service().createSeries(input({ endsAt: new Date(FIRST_AT.getTime() - MS_PER_DAY) }), NOW),
    ).rejects.toThrow("SERIES_END_BEFORE_START");
  });

  it("refuses an occurrence count whose last date falls outside the horizon", async () => {
    seedSalon();
    await expect(
      service().createSeries(input({ intervalWeeks: 2, occurrences: 104 }), NOW),
    ).rejects.toThrow("SERIES_END_TOO_FAR_AHEAD");
    await expect(
      service().createSeries(input({ intervalWeeks: 1, occurrences: MAX_SERIES_OCCURRENCES }), NOW),
    ).resolves.toMatchObject({ active: true });
  });

  it("enforces the occurrence and interval bounds", async () => {
    seedSalon();
    await expect(
      service().createSeries(input({ occurrences: MAX_SERIES_OCCURRENCES + 1 }), NOW),
    ).rejects.toThrow();
    await expect(service().createSeries(input({ occurrences: 0 }), NOW)).rejects.toThrow();
    await expect(
      service().createSeries(input({ intervalWeeks: MAX_SERIES_INTERVAL_WEEKS + 1 }), NOW),
    ).rejects.toThrow();
    await expect(service().createSeries(input({ intervalWeeks: 0 }), NOW)).rejects.toThrow();
    await expect(service().createSeries(input({ intervalWeeks: 1.5 }), NOW)).rejects.toThrow();
  });

  it("refuses an end date and an occurrence count at the same time", async () => {
    seedSalon();
    await expect(
      service().createSeries(
        input({ endsAt: new Date(FIRST_AT.getTime() + 200 * MS_PER_DAY), occurrences: 5 }),
        NOW,
      ),
    ).rejects.toThrow();
  });

  it("refuses unknown fields", async () => {
    seedSalon();
    await expect(service().createSeries(input({ notes: "nope" }), NOW)).rejects.toThrow();
  });

  it("refuses a customer or service that is gone", async () => {
    seedSalon();
    await expect(service().createSeries(input({ customerId: "ghost" }), NOW)).rejects.toThrow(
      "CUSTOMER_NOT_FOUND",
    );

    (db.customers[0] as Row).deletedAt = new Date("2026-01-01T00:00:00.000Z");
    await expect(service().createSeries(input(), NOW)).rejects.toThrow("CUSTOMER_NOT_FOUND");

    (db.customers[0] as Row).deletedAt = null;
    (db.services[0] as Row).isActive = false;
    await expect(service().createSeries(input(), NOW)).rejects.toThrow("SERVICE_NOT_FOUND");
  });

  it("refuses a staff member who does not do that service", async () => {
    seedSalon({ staffIds: [STAFF_A, STAFF_B] });
    db.staffServices.length = 1;
    await expect(service().createSeries(input({ staffId: STAFF_B }), NOW)).rejects.toThrow(
      "STAFF_NOT_ELIGIBLE",
    );
    await expect(service().createSeries(input({ staffId: STAFF_A }), NOW)).resolves.toMatchObject({
      staffId: STAFF_A,
    });
  });

  it("hands the created series straight to the scheduler", async () => {
    seedSalon();
    const created = (await service().createSeries(input({ occurrences: 3 }), NOW)) as Row;
    const report = await service().materialiseDue(NOW, new Date(FIRST_AT.getTime() + MS_PER_DAY));

    expect(report.outcomes[0]).toMatchObject({ seriesId: created.id, status: "booked" });
    expect(db.appointments[0].seriesId).toBe(created.id);
  });
});

describe("reading a series back", () => {
  it("returns the series with its service, staff and recent appointments", async () => {
    seedSalon();
    const series = seedSeries({ staffId: STAFF_A });
    seedAppointment({ id: "one", seriesId: series.id, startsAt: at("2025-12-02", TEN_AM) });
    seedAppointment({ id: "two", seriesId: series.id, startsAt: at("2026-01-13", TEN_AM) });

    const loaded = (await service().getSeries(series.id as string)) as Row;

    expect((loaded.service as Row).slug).toBe("cut");
    expect((loaded.staff as Row).displayName).toBe(STAFF_A);
    expect((loaded.appointments as Row[]).map((row) => row.id)).toEqual(["two", "one"]);
    await expect(service().getSeries("nope")).rejects.toThrow("SERIES_NOT_FOUND");
  });

  it("lists only active series for a customer unless asked otherwise", async () => {
    seedSalon();
    seedSeries({ id: "active-one" });
    seedSeries({ id: "paused-one", active: false, nextAt: at("2026-02-24", TEN_AM) });

    const active = (await service().listSeriesForCustomer(CUSTOMER_ID)) as Row[];
    const all = (await service().listSeriesForCustomer(CUSTOMER_ID, true)) as Row[];

    expect(active.map((row) => row.id)).toEqual(["active-one"]);
    expect(all.map((row) => row.id)).toEqual(["active-one", "paused-one"]);
  });
});

describe("resilience of the cron run", () => {
  const HORIZON = new Date(FIRST_AT.getTime() + MS_PER_DAY);

  it("keeps going for everyone else when one series hits a database fault", async () => {
    seedSalon();
    seedSeries({ id: "series-doomed", nextAt: FIRST_AT });
    seedSeries({
      id: "series-healthy",
      nextAt: new Date(FIRST_AT.getTime() + 60 * MS_PER_MINUTE),
    });
    breakCreateOnCall(1, "Server has closed the connection.");

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.seriesConsidered).toBe(2);
    expect(report.outcomes).toHaveLength(2);
    expect(report.outcomes[0]).toMatchObject({
      seriesId: "series-doomed",
      status: "needs_attention",
      reason: SERIES_MATERIALISATION_FAILED,
    });
    expect(report.outcomes[0].error).toContain("closed the connection");
    expect(report.outcomes[1]).toMatchObject({ seriesId: "series-healthy", status: "booked" });
    expect(report.booked).toBe(1);
    expect(db.appointments).toHaveLength(1);
  });

  it("rolls the cursor back with the failed booking so the next run retries it", async () => {
    seedSalon();
    const series = seedSeries();
    breakCreateOnCall(1, "Server has closed the connection.");

    const failed = await service().materialiseDue(NOW, HORIZON);
    expect(failed.outcomes[0]).toMatchObject({ reason: SERIES_MATERIALISATION_FAILED });
    expect(failed.outcomes[0].occurrenceAt).toEqual(FIRST_AT);
    expect(series.nextAt).toEqual(FIRST_AT);
    expect(db.appointments).toHaveLength(0);
    expect(db.history).toHaveLength(0);

    const retried = await service().materialiseDue(NOW, HORIZON);
    expect(retried.outcomes[0]).toMatchObject({ status: "booked" });
    expect(retried.outcomes[0].occurrenceAt).toEqual(FIRST_AT);
    expect(db.appointments).toHaveLength(1);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });

  it("reports the occurrence that failed, not the one the series started on", async () => {
    seedSalon();
    seedSeries({ intervalWeeks: 1 });
    breakCreateOnCall(3, "Server has closed the connection.");

    const report = await service().materialiseDue(NOW, at("2026-02-11", 0));

    const failure = report.outcomes[report.outcomes.length - 1];
    expect(failure).toMatchObject({ reason: SERIES_MATERIALISATION_FAILED });
    expect(failure.occurrenceAt).toEqual(addSalonWeeks(FIRST_AT, 2));
    expect(report.outcomes.filter((entry) => entry.status === "booked")).toHaveLength(2);
    expect(db.appointments).toHaveLength(2);
  });
});

describe("racing the receptionist", () => {
  const HORIZON = new Date(FIRST_AT.getTime() + MS_PER_DAY);

  it("two people pressing skip at the same time consume one interval, not two", async () => {
    const series = seedSeries();

    const results = await Promise.allSettled([
      service().skipNext(series.id as string),
      service().skipNext(series.id as string),
    ]);

    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as Error).message).toBe("SERIES_CHANGED");
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });

  it("a skip that lands mid-commit makes the scheduler stand down", async () => {
    seedSalon();
    const series = seedSeries();
    db.beforeNextTransaction(() => {
      series.nextAt = addSalonWeeks(FIRST_AT, 6);
    });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes).toEqual([]);
    expect(report.booked).toBe(0);
    expect(db.appointments).toHaveLength(0);
    expect(series.nextAt).toEqual(addSalonWeeks(FIRST_AT, 6));
  });

  it("gives the exact slot to the series that has been waiting longest", async () => {
    seedSalon();
    seedSeries({ id: "waiting-longer", nextAt: FIRST_AT });
    seedSeries({ id: "waiting-less", nextAt: new Date(FIRST_AT.getTime() + MS_PER_MINUTE) });

    const report = await service().materialiseDue(NOW, HORIZON);

    expect(report.outcomes[0]).toMatchObject({ seriesId: "waiting-longer", offsetMinutes: 0 });
    expect(report.outcomes[1]).toMatchObject({ seriesId: "waiting-less", status: "moved" });
    expect(report.outcomes[1].offsetMinutes).toBe(75);
  });
});

describe("known limits", () => {
  it("accepts an explicit null end date alongside an occurrence count", async () => {
    seedSalon();
    const created = (await service().createSeries(
      {
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        intervalWeeks: 6,
        firstAt: FIRST_AT,
        endsAt: null,
        occurrences: 3,
      },
      NOW,
    )) as Row;

    expect(created.endsAt).toEqual(endOfSalonDay(addSalonWeeks(FIRST_AT, 12)));
  });

  it("reports a missing series the same way from every entry point", async () => {
    await expect(service().pause("nope")).rejects.toThrow("SERIES_NOT_FOUND");
    await expect(service().resume("nope", NOW)).rejects.toThrow("SERIES_NOT_FOUND");
    await expect(service().skipNext("nope")).rejects.toThrow("SERIES_NOT_FOUND");
    await expect(service().endSeries("nope")).rejects.toThrow("SERIES_NOT_FOUND");
    await expect(service().getSeries("nope")).rejects.toThrow("SERIES_NOT_FOUND");
  });

  /**
   * The only wall clock a series cannot hold is one inside the hour Europe/Rome skips on
   * the last Sunday of March. There is no such instant, `zonedMinutesToUtc` resolves it
   * forward by the length of the gap, and the shifted time is what the next advance reads
   * back. Holding the original would need the intended minutes stored on the series row.
   * Every minute from 03:00 to 23:59 — the salon opens at 08:00 — is unaffected.
   */
  it("shifts a 02:30 series to 03:30 when an occurrence lands in the skipped hour", () => {
    const start = at("2026-03-22", 150);
    expect(wall(start)).toBe("02:30");

    const onTheGap = addSalonWeeks(start, 1);
    expect(salonDayKey(onTheGap)).toBe("2026-03-29");
    expect(wall(onTheGap)).toBe("03:30");
    expect(wall(addSalonWeeks(onTheGap, 1))).toBe("03:30");
  });

  it("holds every wall clock the salon actually opens on across the same transition", () => {
    for (let minutes = 8 * 60; minutes <= 19 * 60; minutes += 15) {
      const start = at("2026-03-22", minutes);
      expect(salonWallMinutes(addSalonWeeks(start, 1))).toBe(minutes);
      expect(salonWallMinutes(addSalonWeeks(at("2026-10-18", minutes), 1))).toBe(minutes);
    }
  });
});
