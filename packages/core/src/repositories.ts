import { prisma } from "@hair-simo/db";
import type {
  AppointmentStatus,
  Channel,
  CustomerNoteKind,
  InventoryMovementType,
  RoleKey,
} from "@hair-simo/db";
import { addMinutes } from "date-fns";
import { SALON_TIME_ZONE, salonDayKey } from "./time";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_EMBEDDED_SIZE = 20;
const MAX_EMBEDDED_SIZE = 200;

const SERIALIZATION_RETRY_ATTEMPTS = 5;
const SERIALIZATION_RETRY_BASE_DELAY_MS = 20;
const SERIALIZATION_RETRY_MAX_DELAY_MS = 400;
const SERIALIZABLE_TX_OPTIONS = {
  isolationLevel: "Serializable",
  maxWait: 5_000,
  timeout: 10_000,
} as const;

/**
 * Postgres reports a lost serializable race as SQLSTATE 40001 and a deadlock as 40P01.
 * Verified against @prisma/client 6.19.3: a conflict raised while a statement runs, and a
 * conflict raised at COMMIT, both surface as PrismaClientKnownRequestError code "P2034";
 * a mid-statement deadlock surfaces as PrismaClientUnknownRequestError with NO `code` at
 * all and the raw SQLSTATE only inside the message. Matching on the code alone therefore
 * misses real deadlocks, which is why the message is inspected as a fallback.
 */
const SERIALIZATION_SQLSTATE_PATTERN =
  /\b(?:40001|40P01)\b|could not serialize access|deadlock detected/i;
const RETRYABLE_PRISMA_CODES = new Set(["P2034", "P2028"]);

type ServiceClient = Pick<typeof prisma, "service">;

type PaginationInput = { skip?: number; take?: number };

export type BlockingBounds = { spanMinutes: number; bufferMinutes: number };

export type AuditJsonValue =
  string | number | boolean | null | AuditJsonValue[] | { [key: string]: AuditJsonValue };

export function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && !RETRYABLE_PRISMA_CODES.has(code)) return false;
  if (code === "P2034") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && SERIALIZATION_SQLSTATE_PATTERN.test(message);
}

export function serializationBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    SERIALIZATION_RETRY_MAX_DELAY_MS,
    SERIALIZATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
  );
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export async function withSerializationRetry<T>(
  run: (attempt: number) => Promise<T>,
  attempts = SERIALIZATION_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!isSerializationConflict(error)) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      const delay = serializationBackoffMs(attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Widest interval any single appointment can block: the longest service in the catalogue
 * plus the longest buffer. Read from the data, never hard-coded, so adding a five-hour
 * balayage widens the conflict window automatically.
 */
export async function readBlockingBounds(client: ServiceClient): Promise<BlockingBounds> {
  const aggregate = await client.service.aggregate({
    _max: { durationMin: true, bufferAfterMin: true },
  });
  const bufferMinutes = aggregate._max.bufferAfterMin ?? 0;
  return { spanMinutes: (aggregate._max.durationMin ?? 0) + bufferMinutes, bufferMinutes };
}

const BLOCKING_BOUNDS_TTL_MS = 30_000;
let blockingBoundsCache: { value: BlockingBounds; expiresAt: number } | null = null;

async function cachedBlockingBounds(): Promise<BlockingBounds> {
  const now = Date.now();
  if (blockingBoundsCache && blockingBoundsCache.expiresAt > now) return blockingBoundsCache.value;
  const value = await readBlockingBounds(prisma);
  blockingBoundsCache = { value, expiresAt: now + BLOCKING_BOUNDS_TTL_MS };
  return value;
}

export function invalidateBlockingBounds(): void {
  blockingBoundsCache = null;
}

/**
 * A booked appointment can only collide with [startsAt, until) if it starts no earlier than
 * `startsAt - spanMinutes` (nothing shorter than the longest service reaches forward that
 * far) and ends after `startsAt - bufferMinutes`. Both are lower bounds the planner can turn
 * into an index range on Appointment(staffId, startsAt) instead of scanning all history.
 */
export function conflictWindowFilter(startsAt: Date, until: Date, bounds: BlockingBounds) {
  return {
    startsAt: { gte: addMinutes(startsAt, -bounds.spanMinutes), lt: until },
    endsAt: { gt: addMinutes(startsAt, -bounds.bufferMinutes) },
  };
}

function pageSize(take: number | undefined, fallback = DEFAULT_PAGE_SIZE, max = MAX_PAGE_SIZE) {
  if (take === undefined) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(take)));
}

function pageOffset(skip: number | undefined) {
  if (skip === undefined) return undefined;
  return Math.max(0, Math.trunc(skip));
}

const LIVE_CUSTOMER = { deletedAt: null } as const;

function customerVisibility(includeDeleted?: boolean) {
  return includeDeleted ? {} : LIVE_CUSTOMER;
}

/**
 * Timestamps are only millisecond-precise, so rows written in the same tick tie and sort
 * arbitrarily — which also lets `skip`/`take` pagination repeat or drop rows between pages.
 * Every ordered list ends on `id`, which cuid makes both unique and creation-ordered.
 */
function newestFirst() {
  return [{ createdAt: "desc" as const }, { id: "desc" as const }];
}

function oldestFirst() {
  return [{ createdAt: "asc" as const }, { id: "asc" as const }];
}

/** Pinned notes first, then newest — the order every customer-notes surface wants. */
function customerNoteOrder() {
  return [{ pinned: "desc" as const }, ...newestFirst()];
}

function customerDetailInclude(embedded = DEFAULT_EMBEDDED_SIZE) {
  return {
    appointments: {
      orderBy: [{ startsAt: "desc" as const }, { id: "desc" as const }],
      take: embedded,
    },
    notes: { orderBy: customerNoteOrder(), take: embedded },
    consents: { orderBy: newestFirst(), take: embedded },
  };
}

function nullableRange(from?: Date, to?: Date) {
  return { from: from ?? null, to: to ?? null };
}

function toNumber(value: bigint | number | null): number {
  return value === null ? 0 : Number(value);
}

export const salonRepository = {
  listServices: (includeInactive = false) =>
    prisma.service.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: { translations: true },
      orderBy: oldestFirst(),
    }),

  findServiceBySlug: (slug: string) =>
    prisma.service.findUnique({
      where: { slug },
      include: { translations: true },
    }),

  findServiceById: (id: string) =>
    prisma.service.findUnique({
      where: { id },
      include: { translations: true, staffServices: true },
    }),

  createService: async (data: {
    slug: string;
    category: string;
    durationMin: number;
    bufferAfterMin: number;
    priceCents: number;
    translations: { locale: string; name: string; description: string }[];
  }) => {
    const service = await prisma.service.create({
      data: {
        slug: data.slug,
        category: data.category,
        durationMin: data.durationMin,
        bufferAfterMin: data.bufferAfterMin,
        priceCents: data.priceCents,
        translations: { create: data.translations },
      },
      include: { translations: true },
    });
    invalidateBlockingBounds();
    return service;
  },

  updateService: async (
    id: string,
    data: Partial<{
      category: string;
      durationMin: number;
      bufferAfterMin: number;
      priceCents: number;
      isActive: boolean;
    }>,
  ) => {
    const service = await prisma.service.update({
      where: { id },
      data,
      include: { translations: true },
    });
    invalidateBlockingBounds();
    return service;
  },

  upsertServiceTranslation: (
    serviceId: string,
    locale: string,
    name: string,
    description: string,
  ) =>
    prisma.serviceTranslation.upsert({
      where: { serviceId_locale: { serviceId, locale } },
      update: { name, description },
      create: { serviceId, locale, name, description },
    }),

  listStaff: (filters?: { query?: string; isBookable?: boolean; skip?: number; take?: number }) =>
    prisma.staffProfile.findMany({
      where: {
        ...(filters?.isBookable === undefined ? {} : { isBookable: filters.isBookable }),
        ...(filters?.query
          ? {
              OR: [
                { displayName: { contains: filters.query, mode: "insensitive" as const } },
                { user: { email: { contains: filters.query, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      },
      include: {
        user: { include: { roles: { include: { role: true } } } },
        staffServices: { include: { service: true } },
        availability: { orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }] },
        timeOffs: { orderBy: [{ startsAt: "desc" }, { id: "desc" }], take: DEFAULT_EMBEDDED_SIZE },
      },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      skip: pageOffset(filters?.skip),
      take: pageSize(filters?.take),
    }),

  findStaffById: (id: string) =>
    prisma.staffProfile.findUnique({
      where: { id },
      include: {
        user: { include: { roles: { include: { role: true } } } },
        staffServices: { include: { service: { include: { translations: true } } } },
        availability: { orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }] },
        timeOffs: { orderBy: [{ startsAt: "asc" }, { id: "asc" }], take: MAX_EMBEDDED_SIZE },
      },
    }),

  createStaff: (data: {
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    displayName: string;
    bio?: string;
    phone?: string;
    locale: string;
    isBookable: boolean;
    role: RoleKey;
  }) =>
    prisma.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        locale: data.locale,
        roles: {
          create: {
            role: {
              connectOrCreate: {
                where: { key: data.role },
                create: { key: data.role },
              },
            },
          },
        },
        staffProfile: {
          create: {
            displayName: data.displayName,
            bio: data.bio,
            phone: data.phone,
            locale: data.locale,
            isBookable: data.isBookable,
          },
        },
      },
      include: { staffProfile: true, roles: { include: { role: true } } },
    }),

  listStaffAvailability: (staffId: string) =>
    prisma.staffAvailabilityRule.findMany({
      where: { staffId },
      orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }],
    }),

  listStaffTimeOff: (staffId: string, startsAt: Date, endsAt: Date) =>
    prisma.staffTimeOff.findMany({
      where: {
        staffId,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    }),

  updateStaffProfile: (
    id: string,
    data: Partial<{
      displayName: string;
      bio: string | null;
      phone: string | null;
      isBookable: boolean;
    }>,
  ) =>
    prisma.staffProfile.update({
      where: { id },
      data,
      include: { staffServices: true, availability: true },
    }),

  updateStaffUser: (
    userId: string,
    data: Partial<{
      email: string;
      firstName: string;
      lastName: string;
      locale: string;
      active: boolean;
    }>,
  ) => prisma.user.update({ where: { id: userId }, data }),

  deleteStaff: (id: string) =>
    prisma.$transaction(async (tx) => {
      const staff = await tx.staffProfile.findUnique({ where: { id }, select: { userId: true } });
      if (!staff) return null;
      await tx.user.delete({ where: { id: staff.userId } });
      return staff;
    }),

  replaceStaffServices: (staffId: string, serviceIds: string[]) =>
    prisma.$transaction(async (tx) => {
      await tx.staffService.deleteMany({ where: { staffId } });
      if (serviceIds.length > 0) {
        await tx.staffService.createMany({
          data: serviceIds.map((serviceId) => ({ staffId, serviceId })),
        });
      }
      return tx.staffService.findMany({ where: { staffId }, include: { service: true } });
    }),

  replaceStaffAvailability: (
    staffId: string,
    rules: { dayOfWeek: number; startMin: number; endMin: number }[],
  ) =>
    prisma.$transaction(async (tx) => {
      await tx.staffAvailabilityRule.deleteMany({ where: { staffId } });
      if (rules.length > 0) {
        await tx.staffAvailabilityRule.createMany({
          data: rules.map((rule) => ({ staffId, ...rule })),
        });
      }
      return tx.staffAvailabilityRule.findMany({
        where: { staffId },
        orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }],
      });
    }),

  createStaffTimeOff: (staffId: string, data: { startsAt: Date; endsAt: Date; reason?: string }) =>
    prisma.staffTimeOff.create({ data: { staffId, ...data } }),

  findStaffTimeOff: (staffId: string, id: string) =>
    prisma.staffTimeOff.findFirst({ where: { id, staffId } }),

  updateStaffTimeOff: (
    staffId: string,
    id: string,
    data: Partial<{ startsAt: Date; endsAt: Date; reason: string | null }>,
  ) => prisma.staffTimeOff.update({ where: { id, staffId }, data }),

  deleteStaffTimeOff: (staffId: string, id: string) =>
    prisma.staffTimeOff.delete({ where: { id, staffId } }),

  listCustomers: (filters?: {
    query?: string;
    skip?: number;
    take?: number;
    includeDeleted?: boolean;
  }) =>
    prisma.customer.findMany({
      where: {
        ...customerVisibility(filters?.includeDeleted),
        ...(filters?.query
          ? {
              OR: [
                { firstName: { contains: filters.query, mode: "insensitive" as const } },
                { lastName: { contains: filters.query, mode: "insensitive" as const } },
                { email: { contains: filters.query, mode: "insensitive" as const } },
                { phone: { contains: filters.query, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      include: customerDetailInclude(),
      orderBy: newestFirst(),
      skip: pageOffset(filters?.skip),
      take: pageSize(filters?.take),
    }),

  findCustomerById: (id: string, options?: { includeDeleted?: boolean }) =>
    prisma.customer.findFirst({
      where: { id, ...customerVisibility(options?.includeDeleted) },
      include: customerDetailInclude(MAX_EMBEDDED_SIZE),
    }),

  createCustomer: (data: {
    email?: string;
    phone?: string;
    firstName: string;
    lastName: string;
    locale: string;
    sourceChannel: Channel;
    marketingOptIn?: boolean;
  }) => prisma.customer.create({ data }),

  updateCustomer: (
    id: string,
    data: Partial<{
      email: string | null;
      phone: string | null;
      firstName: string;
      lastName: string;
      locale: string;
      marketingOptIn: boolean;
    }>,
  ) => prisma.customer.update({ where: { id }, data }),

  softDeleteCustomer: (id: string, deletedAt = new Date()) =>
    prisma.customer.update({ where: { id }, data: { deletedAt } }),

  restoreCustomer: (id: string) =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id },
        select: { anonymizedAt: true },
      });
      if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
      if (customer.anonymizedAt) throw new Error("CUSTOMER_ANONYMIZED");
      return tx.customer.update({ where: { id }, data: { deletedAt: null } });
    }),

  addCustomerNote: (
    customerId: string,
    note: string,
    options?: { kind?: CustomerNoteKind; authorId?: string; pinned?: boolean },
  ) =>
    prisma.customerNote.create({
      data: {
        customerId,
        note,
        kind: options?.kind ?? "general",
        authorId: options?.authorId,
        pinned: options?.pinned ?? false,
      },
    }),

  listCustomerNotes: (
    customerId: string,
    filters?: { kind?: CustomerNoteKind; skip?: number; take?: number },
  ) =>
    prisma.customerNote.findMany({
      where: { customerId, ...(filters?.kind ? { kind: filters.kind } : {}) },
      orderBy: customerNoteOrder(),
      skip: pageOffset(filters?.skip),
      take: pageSize(filters?.take),
    }),

  setCustomerNotePinned: (id: string, pinned: boolean) =>
    prisma.customerNote.update({ where: { id }, data: { pinned } }),

  recordConsent: (customerId: string, type: string, granted: boolean, source: string) =>
    prisma.consentRecord.create({
      data: { customerId, type, granted, source },
    }),

  listBusinessHours: () => prisma.businessHours.findMany({ orderBy: { dayOfWeek: "asc" } }),

  upsertBusinessHours: (dayOfWeek: number, startMin: number, endMin: number, isOpen: boolean) =>
    prisma.businessHours.upsert({
      where: { id: `day-${dayOfWeek}` },
      update: { startMin, endMin, isOpen },
      create: { id: `day-${dayOfWeek}`, dayOfWeek, startMin, endMin, isOpen },
    }),

  /**
   * A blind `upsert` on email silently resurrects a customer who asked to be erased and
   * hands their old appointment history back to whoever now controls that mailbox. Soft
   * deletion is therefore never undone as a side effect of a booking: the caller gets
   * CUSTOMER_DELETED and must decide (a support agent can call `restoreCustomer`, or pass
   * `restoreDeleted`). Anonymised rows are never reusable at all — the PII behind them is
   * gone and cannot be re-associated with the person on the other end of the request.
   */
  findOrCreateCustomerByEmail: async (
    email: string,
    locale: string,
    sourceChannel: Channel,
    profile?: { firstName?: string; lastName?: string; phone?: string },
    options?: { restoreDeleted?: boolean },
  ) => {
    const update = { locale, sourceChannel, ...profile };

    const reuse = async (existing: {
      id: string;
      deletedAt: Date | null;
      anonymizedAt: Date | null;
    }) => {
      if (existing.anonymizedAt) throw new Error("CUSTOMER_ANONYMIZED");
      if (existing.deletedAt && !options?.restoreDeleted) throw new Error("CUSTOMER_DELETED");
      return prisma.customer.update({
        where: { id: existing.id },
        data: existing.deletedAt ? { ...update, deletedAt: null } : update,
      });
    };

    const existing = await prisma.customer.findUnique({ where: { email } });
    if (existing) return reuse(existing);

    try {
      return await prisma.customer.create({
        data: {
          email,
          firstName: profile?.firstName ?? "Guest",
          lastName: profile?.lastName ?? "Customer",
          phone: profile?.phone,
          locale,
          sourceChannel,
        },
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "P2002") throw error;
      const raced = await prisma.customer.findUnique({ where: { email } });
      if (!raced) throw error;
      return reuse(raced);
    }
  },

  listBlockedAppointments: async (staffId: string | undefined, startsAt: Date, endsAt: Date) => {
    const bounds = await cachedBlockingBounds();
    const appointments = await prisma.appointment.findMany({
      where: {
        ...(staffId ? { staffId } : {}),
        status: { notIn: ["cancelled"] },
        ...conflictWindowFilter(startsAt, endsAt, bounds),
      },
      include: { service: { select: { bufferAfterMin: true } } },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    return appointments.filter(
      (appointment) =>
        addMinutes(appointment.endsAt, appointment.service.bufferAfterMin) > startsAt,
    );
  },

  findAppointmentById: (id: string) =>
    prisma.appointment.findUnique({
      where: { id },
      include: {
        customer: true,
        service: { include: { translations: true } },
        staff: true,
        payments: { orderBy: newestFirst(), take: MAX_EMBEDDED_SIZE },
        statusHistory: { orderBy: newestFirst(), take: MAX_EMBEDDED_SIZE },
      },
    }),

  createAppointment: (input: {
    customerId: string;
    serviceId: string;
    staffId?: string;
    startsAt: Date;
    endsAt: Date;
    locale: string;
    sourceChannel: Channel;
    status?: AppointmentStatus;
  }) =>
    prisma.appointment.create({
      data: {
        customerId: input.customerId,
        serviceId: input.serviceId,
        staffId: input.staffId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        locale: input.locale,
        sourceChannel: input.sourceChannel,
        status: input.status ?? "pending",
        statusHistory: {
          create: { status: input.status ?? "pending", reason: "initial booking" },
        },
      },
      include: { customer: true, service: true, staff: true },
    }),

  createAppointmentIfAvailable: (input: {
    customerId: string;
    serviceId: string;
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    blockedEndsAt: Date;
    locale: string;
    sourceChannel: Channel;
  }) =>
    withSerializationRetry(() =>
      prisma.$transaction(async (tx) => {
        const bounds = await readBlockingBounds(tx);
        const candidates = await tx.appointment.findMany({
          where: {
            staffId: input.staffId,
            status: { not: "cancelled" },
            ...conflictWindowFilter(input.startsAt, input.blockedEndsAt, bounds),
          },
          include: { service: { select: { bufferAfterMin: true } } },
        });
        const conflict = candidates.some(
          (item) => addMinutes(item.endsAt, item.service.bufferAfterMin) > input.startsAt,
        );
        if (conflict) throw new Error("SLOT_NOT_AVAILABLE");
        return tx.appointment.create({
          data: {
            customerId: input.customerId,
            serviceId: input.serviceId,
            staffId: input.staffId,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            locale: input.locale,
            sourceChannel: input.sourceChannel,
            statusHistory: { create: { status: "pending", reason: "initial booking" } },
          },
          include: { customer: true, service: true, staff: true },
        });
      }, SERIALIZABLE_TX_OPTIONS),
    ),

  updateAppointmentStatus: (appointmentId: string, status: AppointmentStatus, reason?: string) =>
    prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status,
        cancellationReason: reason,
        statusHistory: { create: { status, reason } },
      },
      include: { customer: true, service: true, staff: true },
    }),

  rescheduleAppointment: (appointmentId: string, startsAt: Date, endsAt: Date) =>
    prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        startsAt,
        endsAt,
        status: "confirmed",
        statusHistory: { create: { status: "confirmed", reason: "rescheduled" } },
      },
      include: { customer: true, service: true, staff: true },
    }),

  rescheduleAppointmentIfAvailable: (
    appointmentId: string,
    staffId: string,
    startsAt: Date,
    endsAt: Date,
    blockedEndsAt: Date,
  ) =>
    withSerializationRetry(() =>
      prisma.$transaction(async (tx) => {
        const bounds = await readBlockingBounds(tx);
        const candidates = await tx.appointment.findMany({
          where: {
            id: { not: appointmentId },
            staffId,
            status: { not: "cancelled" },
            ...conflictWindowFilter(startsAt, blockedEndsAt, bounds),
          },
          include: { service: { select: { bufferAfterMin: true } } },
        });
        const conflict = candidates.some(
          (item) => addMinutes(item.endsAt, item.service.bufferAfterMin) > startsAt,
        );
        if (conflict) throw new Error("SLOT_NOT_AVAILABLE");
        return tx.appointment.update({
          where: { id: appointmentId },
          data: {
            staffId,
            startsAt,
            endsAt,
            status: "confirmed",
            statusHistory: { create: { status: "confirmed", reason: "rescheduled" } },
          },
          include: { customer: true, service: true, staff: true },
        });
      }, SERIALIZABLE_TX_OPTIONS),
    ),

  listAppointments: (filters?: {
    from?: Date;
    to?: Date;
    statuses?: AppointmentStatus[];
    staffId?: string;
    customerId?: string;
    serviceId?: string;
    query?: string;
    skip?: number;
    take?: number;
  }) =>
    prisma.appointment.findMany({
      where: {
        ...(filters?.from || filters?.to
          ? {
              startsAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
        ...(filters?.statuses?.length ? { status: { in: filters.statuses } } : {}),
        ...(filters?.staffId ? { staffId: filters.staffId } : {}),
        ...(filters?.customerId ? { customerId: filters.customerId } : {}),
        ...(filters?.serviceId ? { serviceId: filters.serviceId } : {}),
        ...(filters?.query
          ? {
              OR: [
                {
                  customer: {
                    firstName: { contains: filters.query, mode: "insensitive" as const },
                  },
                },
                {
                  customer: { lastName: { contains: filters.query, mode: "insensitive" as const } },
                },
                { customer: { email: { contains: filters.query, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      },
      include: {
        customer: true,
        service: true,
        staff: true,
        payments: { orderBy: newestFirst(), take: DEFAULT_EMBEDDED_SIZE },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      skip: pageOffset(filters?.skip),
      take: pageSize(filters?.take),
    }),

  listAppointmentsBetween: (
    from: Date,
    to: Date,
    statuses: AppointmentStatus[],
    limit = MAX_PAGE_SIZE,
  ) =>
    prisma.appointment.findMany({
      where: {
        startsAt: { gte: from, lte: to },
        status: { in: statuses },
      },
      include: { customer: true, service: true, staff: true },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: pageSize(limit, MAX_PAGE_SIZE, 1_000),
    }),

  listCallLogs: (limit = DEFAULT_PAGE_SIZE) =>
    prisma.callLog.findMany({
      include: { customer: true },
      orderBy: newestFirst(),
      take: pageSize(limit),
    }),

  listNotificationLogs: (limit = DEFAULT_PAGE_SIZE) =>
    prisma.notificationLog.findMany({
      include: { appointment: true },
      orderBy: newestFirst(),
      take: pageSize(limit),
    }),

  findNotificationLogById: (id: string) =>
    prisma.notificationLog.findUnique({ where: { id }, include: { appointment: true } }),

  listNotifications: (limit = DEFAULT_PAGE_SIZE) =>
    prisma.notificationLog.findMany({
      include: { appointment: true },
      orderBy: newestFirst(),
      take: pageSize(limit),
    }),

  listProducts: (filters?: { query?: string; lowStockAt?: number; skip?: number; take?: number }) =>
    prisma.product.findMany({
      where: {
        ...(filters?.query
          ? {
              OR: [
                { name: { contains: filters.query, mode: "insensitive" as const } },
                { sku: { contains: filters.query, mode: "insensitive" as const } },
              ],
            }
          : {}),
        ...(filters?.lowStockAt === undefined ? {} : { stock: { lte: filters.lowStockAt } }),
      },
      include: { inventoryMovements: { orderBy: newestFirst(), take: 10 } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: pageOffset(filters?.skip),
      take: pageSize(filters?.take),
    }),

  findProductById: (id: string) =>
    prisma.product.findUnique({
      where: { id },
      include: { inventoryMovements: { orderBy: newestFirst(), take: MAX_EMBEDDED_SIZE } },
    }),

  createProduct: (data: { sku: string; name: string; priceCents: number; stock: number }) =>
    prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data });
      if (data.stock > 0) {
        await tx.inventoryMovement.create({
          data: {
            productId: product.id,
            delta: data.stock,
            balanceAfter: data.stock,
            reason: "initial stock",
          },
        });
      }
      return product;
    }),

  updateProduct: (id: string, data: Partial<{ sku: string; name: string; priceCents: number }>) =>
    prisma.product.update({ where: { id }, data }),

  deleteProduct: (id: string) => prisma.product.delete({ where: { id } }),

  listProductInventoryMovements: (productId: string, limit = 100) =>
    prisma.inventoryMovement.findMany({
      where: { productId },
      orderBy: newestFirst(),
      take: pageSize(limit, 100),
    }),

  adjustProductStock: (
    productId: string,
    data: { quantity: number; type: InventoryMovementType; reason?: string },
  ) =>
    prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id: productId },
        data: { stock: { increment: data.quantity } },
      });
      if (product.stock < 0) throw new Error("INSUFFICIENT_STOCK");
      const movement = await tx.inventoryMovement.create({
        data: {
          productId,
          delta: data.quantity,
          type: data.type,
          reason: data.reason,
          balanceAfter: product.stock,
        },
      });
      return { product, movement };
    }),

  listInventory: () => prisma.product.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] }),

  createAuditLog: (entry: {
    actorId?: string;
    actorEmail: string;
    actorRole: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: AuditJsonValue;
    after?: AuditJsonValue;
    ip?: string;
    userAgent?: string;
  }) =>
    prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        actorRole: entry.actorRole,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
        ip: entry.ip,
        userAgent: entry.userAgent,
      },
    }),

  listAuditLog: (
    filter?: {
      actorId?: string;
      action?: string;
      entityType?: string;
      entityId?: string;
      from?: Date;
      to?: Date;
    },
    pagination?: PaginationInput,
  ) =>
    prisma.auditLog.findMany({
      where: {
        ...(filter?.actorId ? { actorId: filter.actorId } : {}),
        ...(filter?.action ? { action: filter.action } : {}),
        ...(filter?.entityType ? { entityType: filter.entityType } : {}),
        ...(filter?.entityId ? { entityId: filter.entityId } : {}),
        ...(filter?.from || filter?.to
          ? {
              createdAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      orderBy: newestFirst(),
      skip: pageOffset(pagination?.skip),
      take: pageSize(pagination?.take),
    }),

  createWaitlistEntry: (input: {
    customerId: string;
    serviceId: string;
    staffId?: string;
    earliestAt: Date;
    latestAt: Date;
    locale?: string;
    channel?: Channel;
  }) =>
    prisma.waitlist.create({
      data: {
        customerId: input.customerId,
        serviceId: input.serviceId,
        staffId: input.staffId,
        earliestAt: input.earliestAt,
        latestAt: input.latestAt,
        locale: input.locale ?? "en",
        channel: input.channel ?? "web",
      },
      include: { customer: true, service: true, staff: true },
    }),

  /** Entries whose [earliestAt, latestAt] range overlaps the freed window, oldest first. */
  listActiveWaitlistFor: (
    serviceId: string,
    window: { from: Date; to: Date },
    options?: { staffId?: string; take?: number },
  ) =>
    prisma.waitlist.findMany({
      where: {
        serviceId,
        status: "active",
        earliestAt: { lt: window.to },
        latestAt: { gt: window.from },
        ...(options?.staffId ? { OR: [{ staffId: options.staffId }, { staffId: null }] } : {}),
      },
      include: { customer: true, service: true, staff: true },
      orderBy: oldestFirst(),
      take: pageSize(options?.take),
    }),

  markWaitlistNotified: (id: string, notifiedAt = new Date()) =>
    prisma.waitlist.update({ where: { id }, data: { status: "notified", notifiedAt } }),

  markWaitlistConverted: (id: string, appointmentId: string) =>
    prisma.waitlist.update({
      where: { id },
      data: { status: "converted", convertedAppointmentId: appointmentId },
    }),

  expireWaitlistBefore: (cutoff: Date) =>
    prisma.waitlist.updateMany({
      where: { status: { in: ["active", "notified"] }, latestAt: { lt: cutoff } },
      data: { status: "expired" },
    }),

  upsertConversationMessage: (input: {
    channel: Channel;
    locale: string;
    customerId?: string;
    role: string;
    content: string;
    externalRef?: string;
  }) =>
    prisma.$transaction(async (tx) => {
      const conversation = input.externalRef
        ? ((await tx.conversation.findFirst({ where: { externalRef: input.externalRef } })) ??
          (await tx.conversation.create({
            data: {
              channel: input.channel,
              locale: input.locale,
              customerId: input.customerId,
              externalRef: input.externalRef,
            },
          })))
        : await tx.conversation.create({
            data: {
              channel: input.channel,
              locale: input.locale,
              customerId: input.customerId,
            },
          });

      await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: input.role,
          content: input.content,
        },
      });

      return conversation;
    }),

  getDashboardStats: async () => {
    const [appointments, customers, services, payments, noShows, completed] = await Promise.all([
      prisma.appointment.count({ where: { status: { not: "cancelled" } } }),
      prisma.customer.count({ where: LIVE_CUSTOMER }),
      prisma.service.count({ where: { isActive: true } }),
      prisma.payment.aggregate({ _sum: { amountCents: true }, where: { status: "paid" } }),
      prisma.appointment.count({ where: { status: "no_show" } }),
      prisma.appointment.count({ where: { status: "completed" } }),
    ]);

    const utilizationBase = completed + noShows;
    const noShowRate = utilizationBase === 0 ? 0 : Math.round((noShows / utilizationBase) * 100);

    return {
      appointments,
      customers,
      services,
      revenueCents: payments._sum.amountCents ?? 0,
      noShowRate,
    };
  },

  getReportStats: async (from?: Date, to?: Date) => {
    const range = nullableRange(from, to);
    const appointmentRange =
      from || to
        ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {};
    const paymentRange =
      from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {};

    const [paid, pending, cancelled, upcoming, completed, noShows, breakdown, revenueByDay] =
      await Promise.all([
        prisma.payment.aggregate({
          _sum: { amountCents: true },
          _count: true,
          where: { status: "paid", ...paymentRange },
        }),
        prisma.appointment.count({ where: { status: "pending", ...appointmentRange } }),
        prisma.appointment.count({ where: { status: "cancelled", ...appointmentRange } }),
        prisma.appointment.count({
          where: {
            startsAt: {
              gte: from && from > new Date() ? from : new Date(),
              ...(to ? { lte: to } : {}),
            },
            status: { in: ["pending", "confirmed"] },
          },
        }),
        prisma.appointment.count({ where: { status: "completed", ...appointmentRange } }),
        prisma.appointment.count({ where: { status: "no_show", ...appointmentRange } }),
        // One grouped pass in Postgres instead of streaming every appointment plus its
        // translations and payments into JS. The result is bounded by services x staff.
        prisma.$queryRaw<
          { serviceId: string; staffId: string | null; count: bigint; revenueCents: bigint }[]
        >`
          SELECT a."serviceId" AS "serviceId",
                 a."staffId" AS "staffId",
                 COUNT(*)::bigint AS "count",
                 COALESCE(SUM(paid."amountCents"), 0)::bigint AS "revenueCents"
          FROM "Appointment" a
          LEFT JOIN LATERAL (
            SELECT SUM(p."amountCents") AS "amountCents"
            FROM "Payment" p
            WHERE p."appointmentId" = a."id" AND p."status" = 'paid'
          ) paid ON TRUE
          WHERE (${range.from}::timestamptz IS NULL OR a."startsAt" >= ${range.from}::timestamptz)
            AND (${range.to}::timestamptz IS NULL OR a."startsAt" <= ${range.to}::timestamptz)
          GROUP BY a."serviceId", a."staffId"
        `,
        // Bucketing in JS on payment.createdAt.toISOString() cuts the day at UTC midnight,
        // so a 00:30 Rome payment landed in the previous day's revenue. Postgres groups on
        // the salon-local calendar day and hands back the UTC instant of that local midnight.
        prisma.$queryRaw<{ bucketStart: Date; amountCents: bigint }[]>`
          SELECT (
                   date_trunc('day', p."createdAt" AT TIME ZONE ${SALON_TIME_ZONE}::text)
                   AT TIME ZONE ${SALON_TIME_ZONE}::text
                 ) AS "bucketStart",
                 COALESCE(SUM(p."amountCents"), 0)::bigint AS "amountCents"
          FROM "Payment" p
          WHERE p."status" = 'paid'
            AND (${range.from}::timestamptz IS NULL OR p."createdAt" >= ${range.from}::timestamptz)
            AND (${range.to}::timestamptz IS NULL OR p."createdAt" <= ${range.to}::timestamptz)
          GROUP BY 1
          ORDER BY 1
        `,
      ]);

    const serviceIds = [...new Set(breakdown.map((row) => row.serviceId))];
    const staffIds = breakdown
      .map((row) => row.staffId)
      .filter((value): value is string => value !== null);

    const [services, staff] = await Promise.all([
      serviceIds.length
        ? prisma.service.findMany({
            where: { id: { in: serviceIds } },
            select: {
              id: true,
              slug: true,
              translations: { where: { locale: "de" }, select: { name: true } },
            },
          })
        : [],
      staffIds.length
        ? prisma.staffProfile.findMany({
            where: { id: { in: [...new Set(staffIds)] } },
            select: { id: true, displayName: true },
          })
        : [],
    ]);

    const serviceLabels = new Map(
      services.map((entry) => [entry.id, entry.translations[0]?.name ?? entry.slug]),
    );
    const staffLabels = new Map(staff.map((entry) => [entry.id, entry.displayName]));

    const fold = (
      keyOf: (row: (typeof breakdown)[number]) => string,
      labels: Map<string, string>,
    ) => {
      const grouped = new Map<string, { label: string; count: number; revenueCents: number }>();
      for (const row of breakdown) {
        const key = keyOf(row);
        const entry = grouped.get(key) ?? {
          label: labels.get(key) ?? (key === "unassigned" ? "Unassigned" : key),
          count: 0,
          revenueCents: 0,
        };
        entry.count += toNumber(row.count);
        entry.revenueCents += toNumber(row.revenueCents);
        grouped.set(key, entry);
      }
      return [...grouped.values()].sort((a, b) => b.count - a.count);
    };

    return {
      revenueCents: paid._sum.amountCents ?? 0,
      paidPayments: paid._count,
      pendingAppointments: pending,
      cancelledAppointments: cancelled,
      upcomingAppointments: upcoming,
      completedAppointments: completed,
      noShowAppointments: noShows,
      byService: fold((row) => row.serviceId, serviceLabels),
      byStaff: fold((row) => row.staffId ?? "unassigned", staffLabels),
      dailyRevenue: revenueByDay.map((row) => ({
        label: salonDayKey(row.bucketStart),
        value: toNumber(row.amountCents),
      })),
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
    };
  },
};
