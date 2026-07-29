import { prisma } from "@hair-simo/db";
import type { AppointmentStatus, Channel, InventoryMovementType, RoleKey } from "@hair-simo/db";
import { addMinutes } from "date-fns";

export const salonRepository = {
  listServices: (includeInactive = false) =>
    prisma.service.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: { translations: true },
      orderBy: { createdAt: "asc" },
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

  createService: (data: {
    slug: string;
    category: string;
    durationMin: number;
    bufferAfterMin: number;
    priceCents: number;
    translations: { locale: string; name: string; description: string }[];
  }) =>
    prisma.service.create({
      data: {
        slug: data.slug,
        category: data.category,
        durationMin: data.durationMin,
        bufferAfterMin: data.bufferAfterMin,
        priceCents: data.priceCents,
        translations: { create: data.translations },
      },
      include: { translations: true },
    }),

  updateService: (
    id: string,
    data: Partial<{
      category: string;
      durationMin: number;
      bufferAfterMin: number;
      priceCents: number;
      isActive: boolean;
    }>,
  ) =>
    prisma.service.update({
      where: { id },
      data,
      include: { translations: true },
    }),

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
        availability: true,
        timeOffs: true,
      },
      orderBy: { displayName: "asc" },
      skip: filters?.skip,
      take: filters?.take,
    }),

  findStaffById: (id: string) =>
    prisma.staffProfile.findUnique({
      where: { id },
      include: {
        user: { include: { roles: { include: { role: true } } } },
        staffServices: { include: { service: { include: { translations: true } } } },
        availability: { orderBy: [{ dayOfWeek: "asc" }, { startMin: "asc" }] },
        timeOffs: { orderBy: { startsAt: "asc" } },
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
    prisma.staffAvailabilityRule.findMany({ where: { staffId }, orderBy: { dayOfWeek: "asc" } }),

  listStaffTimeOff: (staffId: string, startsAt: Date, endsAt: Date) =>
    prisma.staffTimeOff.findMany({
      where: {
        staffId,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
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

  deleteStaff: async (id: string) => {
    const staff = await prisma.staffProfile.findUnique({ where: { id }, select: { userId: true } });
    if (!staff) return null;
    await prisma.user.delete({ where: { id: staff.userId } });
    return staff;
  },

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

  listCustomers: (filters?: { query?: string; skip?: number; take?: number }) =>
    prisma.customer.findMany({
      where: filters?.query
        ? {
            OR: [
              { firstName: { contains: filters.query, mode: "insensitive" } },
              { lastName: { contains: filters.query, mode: "insensitive" } },
              { email: { contains: filters.query, mode: "insensitive" } },
              { phone: { contains: filters.query, mode: "insensitive" } },
            ],
          }
        : undefined,
      include: { appointments: true, notes: true, consents: true },
      orderBy: { createdAt: "desc" },
      skip: filters?.skip,
      take: filters?.take,
    }),

  findCustomerById: (id: string) =>
    prisma.customer.findUnique({
      where: { id },
      include: { appointments: true, notes: true, consents: true },
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

  addCustomerNote: (customerId: string, note: string) =>
    prisma.customerNote.create({ data: { customerId, note } }),

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

  findOrCreateCustomerByEmail: (
    email: string,
    locale: string,
    sourceChannel: Channel,
    profile?: { firstName?: string; lastName?: string; phone?: string },
  ) =>
    prisma.customer.upsert({
      where: { email },
      update: { locale, sourceChannel, ...profile },
      create: {
        email,
        firstName: profile?.firstName ?? "Guest",
        lastName: profile?.lastName ?? "Customer",
        phone: profile?.phone,
        locale,
        sourceChannel,
      },
    }),

  listBlockedAppointments: async (staffId: string | undefined, startsAt: Date, endsAt: Date) => {
    const appointments = await prisma.appointment.findMany({
      where: {
        ...(staffId ? { staffId } : {}),
        status: { notIn: ["cancelled"] },
        startsAt: { lt: endsAt },
      },
      include: { service: { select: { bufferAfterMin: true } } },
      orderBy: { startsAt: "asc" },
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
        payments: true,
        statusHistory: true,
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
    prisma.$transaction(
      async (tx) => {
        const candidates = await tx.appointment.findMany({
          where: {
            staffId: input.staffId,
            status: { not: "cancelled" },
            startsAt: { lt: input.blockedEndsAt },
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
      },
      { isolationLevel: "Serializable" },
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
    prisma.$transaction(
      async (tx) => {
        const candidates = await tx.appointment.findMany({
          where: {
            id: { not: appointmentId },
            staffId,
            status: { not: "cancelled" },
            startsAt: { lt: blockedEndsAt },
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
      },
      { isolationLevel: "Serializable" },
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
      include: { customer: true, service: true, staff: true, payments: true },
      orderBy: { startsAt: "asc" },
      skip: filters?.skip,
      take: filters?.take,
    }),

  listAppointmentsBetween: (from: Date, to: Date, statuses: AppointmentStatus[]) =>
    prisma.appointment.findMany({
      where: {
        startsAt: { gte: from, lte: to },
        status: { in: statuses },
      },
      include: { customer: true, service: true, staff: true },
      orderBy: { startsAt: "asc" },
    }),

  listCallLogs: (limit = 50) =>
    prisma.callLog.findMany({
      include: { customer: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),

  listNotificationLogs: (limit = 50) =>
    prisma.notificationLog.findMany({
      include: { appointment: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),

  findNotificationLogById: (id: string) =>
    prisma.notificationLog.findUnique({ where: { id }, include: { appointment: true } }),

  listNotifications: (limit = 50) =>
    prisma.notificationLog.findMany({
      include: { appointment: true },
      orderBy: { createdAt: "desc" },
      take: limit,
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
      include: { inventoryMovements: { orderBy: { createdAt: "desc" }, take: 10 } },
      orderBy: { name: "asc" },
      skip: filters?.skip,
      take: filters?.take,
    }),

  findProductById: (id: string) =>
    prisma.product.findUnique({
      where: { id },
      include: { inventoryMovements: { orderBy: { createdAt: "desc" } } },
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
      orderBy: { createdAt: "desc" },
      take: limit,
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

  listInventory: () => prisma.product.findMany({ orderBy: { name: "asc" } }),

  upsertConversationMessage: async (input: {
    channel: Channel;
    locale: string;
    customerId?: string;
    role: string;
    content: string;
    externalRef?: string;
  }) => {
    let conversation = input.externalRef
      ? await prisma.conversation.findFirst({ where: { externalRef: input.externalRef } })
      : null;

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          channel: input.channel,
          locale: input.locale,
          customerId: input.customerId,
          externalRef: input.externalRef,
        },
      });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: input.role,
        content: input.content,
      },
    });

    return conversation;
  },

  getDashboardStats: async () => {
    const [appointments, customers, services, payments] = await Promise.all([
      prisma.appointment.count({ where: { status: { not: "cancelled" } } }),
      prisma.customer.count(),
      prisma.service.count({ where: { isActive: true } }),
      prisma.payment.aggregate({ _sum: { amountCents: true }, where: { status: "paid" } }),
    ]);

    const noShows = await prisma.appointment.count({ where: { status: "no_show" } });
    const completed = await prisma.appointment.count({ where: { status: "completed" } });
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
    const appointmentRange =
      from || to
        ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {};
    const paymentRange =
      from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {};
    const [paid, pending, cancelled, upcoming, completed, noShows, breakdownAppointments, paidRows] = await Promise.all([
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
      prisma.appointment.findMany({
        where: appointmentRange,
        include: {
          service: { include: { translations: true } },
          staff: true,
          payments: { where: { status: "paid" } },
        },
      }),
      prisma.payment.findMany({
        where: { status: "paid", ...paymentRange },
        select: { amountCents: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const serviceMap = new Map<string, { label: string; count: number; revenueCents: number }>();
    const staffMap = new Map<string, { label: string; count: number; revenueCents: number }>();
    for (const appointment of breakdownAppointments) {
      const revenueCents = appointment.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const serviceLabel =
        appointment.service.translations.find((translation) => translation.locale === "de")?.name ??
        appointment.service.slug;
      const serviceEntry = serviceMap.get(appointment.serviceId) ?? {
        label: serviceLabel,
        count: 0,
        revenueCents: 0,
      };
      serviceEntry.count += 1;
      serviceEntry.revenueCents += revenueCents;
      serviceMap.set(appointment.serviceId, serviceEntry);
      const staffKey = appointment.staffId ?? "unassigned";
      const staffEntry = staffMap.get(staffKey) ?? {
        label: appointment.staff?.displayName ?? "Unassigned",
        count: 0,
        revenueCents: 0,
      };
      staffEntry.count += 1;
      staffEntry.revenueCents += revenueCents;
      staffMap.set(staffKey, staffEntry);
    }
    const dayMap = new Map<string, number>();
    for (const payment of paidRows) {
      const label = payment.createdAt.toISOString().slice(0, 10);
      dayMap.set(label, (dayMap.get(label) ?? 0) + payment.amountCents);
    }

    return {
      revenueCents: paid._sum.amountCents ?? 0,
      paidPayments: paid._count,
      pendingAppointments: pending,
      cancelledAppointments: cancelled,
      upcomingAppointments: upcoming,
      completedAppointments: completed,
      noShowAppointments: noShows,
      byService: [...serviceMap.values()].sort((a, b) => b.count - a.count),
      byStaff: [...staffMap.values()].sort((a, b) => b.count - a.count),
      dailyRevenue: [...dayMap].map(([label, value]) => ({ label, value })),
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
    };
  },
};
