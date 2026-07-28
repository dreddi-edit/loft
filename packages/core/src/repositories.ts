import { prisma, type AppointmentStatus, type Channel } from "@hair-simo/db";

export const salonRepository = {
  listServices: () =>
    prisma.service.findMany({
      where: { isActive: true },
      include: { translations: true },
      orderBy: { createdAt: "asc" },
    }),

  findServiceBySlug: (slug: string) =>
    prisma.service.findUnique({
      where: { slug },
      include: { translations: true },
    }),

  findOrCreateCustomerByEmail: (email: string, locale: string, sourceChannel: Channel) =>
    prisma.customer.upsert({
      where: { email },
      update: { locale, sourceChannel },
      create: {
        email,
        firstName: "Guest",
        lastName: "Customer",
        locale,
        sourceChannel,
      },
    }),

  listBlockedAppointments: (staffId: string | undefined, startsAt: Date, endsAt: Date) =>
    prisma.appointment.findMany({
      where: {
        staffId,
        status: { not: "cancelled" },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      orderBy: { startsAt: "asc" },
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
};
