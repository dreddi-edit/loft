import { prisma, type AppointmentStatus, type Channel } from "@hair-simo/db";

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

  listStaff: () =>
    prisma.staffProfile.findMany({
      include: {
        user: { include: { roles: { include: { role: true } } } },
        staffServices: { include: { service: true } },
        availability: true,
      },
      orderBy: { displayName: "asc" },
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
      include: { customer: true, service: true, staff: true, payments: true, statusHistory: true },
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
};
