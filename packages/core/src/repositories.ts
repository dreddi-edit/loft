import { prisma } from "@hair-simo/db";
import type { AppointmentStatus, Channel } from "@hair-simo/db";

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

  upsertServiceTranslation: (serviceId: string, locale: string, name: string, description: string) =>
    prisma.serviceTranslation.upsert({
      where: { serviceId_locale: { serviceId, locale } },
      update: { name, description },
      create: { serviceId, locale, name, description },
    }),

  listStaff: () =>
    prisma.staffProfile.findMany({
      include: {
        user: { include: { roles: { include: { role: true } } } },
        staffServices: { include: { service: true } },
        availability: true,
      },
      orderBy: { displayName: "asc" },
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
    data: Partial<{ displayName: string; bio: string | null; phone: string | null; isBookable: boolean }>,
  ) =>
    prisma.staffProfile.update({
      where: { id },
      data,
      include: { staffServices: true, availability: true },
    }),

  listCustomers: () =>
    prisma.customer.findMany({
      include: { appointments: true, notes: true, consents: true },
      orderBy: { createdAt: "desc" },
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

  listBlockedAppointments: (staffId: string | undefined, startsAt: Date, endsAt: Date) =>
    prisma.appointment.findMany({
      where: {
        ...(staffId ? { staffId } : {}),
        status: { notIn: ["cancelled"] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      orderBy: { startsAt: "asc" },
    }),

  findAppointmentById: (id: string) =>
    prisma.appointment.findUnique({
      where: { id },
      include: { customer: true, service: { include: { translations: true } }, staff: true, payments: true, statusHistory: true },
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

  listAppointments: () =>
    prisma.appointment.findMany({
      include: { customer: true, service: true, staff: true, payments: true },
      orderBy: { startsAt: "asc" },
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

  listProducts: () => prisma.product.findMany({ orderBy: { name: "asc" } }),

  listInventory: () => prisma.inventoryItem.findMany({ orderBy: { name: "asc" } }),

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

  getReportStats: async () => {
    const [paid, pending, cancelled, upcoming] = await Promise.all([
      prisma.payment.aggregate({ _sum: { amountCents: true }, where: { status: "paid" } }),
      prisma.appointment.count({ where: { status: "pending" } }),
      prisma.appointment.count({ where: { status: "cancelled" } }),
      prisma.appointment.count({
        where: { startsAt: { gte: new Date() }, status: { in: ["pending", "confirmed"] } },
      }),
    ]);

    return {
      revenueCents: paid._sum.amountCents ?? 0,
      pendingAppointments: pending,
      cancelledAppointments: cancelled,
      upcomingAppointments: upcoming,
    };
  },
};
