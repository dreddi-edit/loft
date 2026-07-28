import { addHours, addMinutes, endOfDay, startOfDay } from "date-fns";
import { z } from "zod";
import { buildSlotsForWindow, intersectWindows, mergeUniqueSlots, minutesToDate } from "./availability-engine";
import { salonRepository } from "./repositories";

const bookingRequestSchema = z.object({
  serviceSlug: z.string().min(1),
  startsAt: z.string().datetime(),
  customerEmail: z.string().email(),
  customerFirstName: z.string().min(1).optional(),
  customerLastName: z.string().min(1).optional(),
  customerPhone: z.string().optional(),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
  sourceChannel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
  staffId: z.string().optional(),
  marketingOptIn: z.boolean().optional(),
  termsAccepted: z.boolean().optional(),
});

export class BookingService {
  private async getEligibleStaff(serviceId: string, staffId?: string) {
    const allStaff = await salonRepository.listStaff();
    const eligible = allStaff.filter(
      (member) =>
        member.isBookable &&
        member.staffServices.some((link) => link.serviceId === serviceId) &&
        (!staffId || member.id === staffId),
    );
    if (staffId && eligible.length === 0) throw new Error("STAFF_NOT_ELIGIBLE");
    return eligible;
  }

  private async getAvailabilityForStaff(
    service: { durationMin: number; bufferAfterMin: number },
    staffId: string,
    day: Date,
  ) {
    const dayStart = startOfDay(day);
    const dayEnd = endOfDay(day);
    const dayOfWeek = day.getDay();

    const [businessHours, staffRules, timeOffs, appointments] = await Promise.all([
      salonRepository.listBusinessHours(),
      salonRepository.listStaffAvailability(staffId),
      salonRepository.listStaffTimeOff(staffId, dayStart, dayEnd),
      salonRepository.listBlockedAppointments(staffId, dayStart, dayEnd),
    ]);

    const business = businessHours.find((entry) => entry.dayOfWeek === dayOfWeek);
    if (!business?.isOpen) return [];

    const businessWindow = {
      dayStart: minutesToDate(day, business.startMin),
      dayEnd: minutesToDate(day, business.endMin),
    };

    const staffDayRules = staffRules.filter((rule) => rule.dayOfWeek === dayOfWeek);
    if (staffDayRules.length === 0) return [];

    const blocked = [
      ...appointments.map((item) => ({ startsAt: item.startsAt, endsAt: item.endsAt })),
      ...timeOffs.map((item) => ({ startsAt: item.startsAt, endsAt: item.endsAt })),
    ];

    const slots = staffDayRules.flatMap((rule) => {
      const staffWindow = {
        dayStart: minutesToDate(day, rule.startMin),
        dayEnd: minutesToDate(day, rule.endMin),
      };
      const window = intersectWindows(businessWindow, staffWindow);
      if (!window) return [];
      return buildSlotsForWindow({
        window,
        serviceDurationMin: service.durationMin,
        bufferAfterMin: service.bufferAfterMin,
        intervalMin: 15,
        blocked,
      });
    });

    return mergeUniqueSlots(slots);
  }

  async getAvailability(serviceSlug: string, dayIso: string, staffId?: string) {
    const service = await salonRepository.findServiceBySlug(serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");

    const day = new Date(dayIso);
    const staffMembers = await this.getEligibleStaff(service.id, staffId);

    if (staffMembers.length === 0) {
      if (staffId) throw new Error("STAFF_NOT_ELIGIBLE");
      return [];
    }

    const allSlots = await Promise.all(
      staffMembers.map((member) => this.getAvailabilityForStaff(service, member.id, day)),
    );

    return mergeUniqueSlots(allSlots.flat());
  }

  async createBooking(rawInput: unknown) {
    const input = bookingRequestSchema.parse(rawInput);
    if (input.termsAccepted === false) throw new Error("TERMS_NOT_ACCEPTED");

    const service = await salonRepository.findServiceBySlug(input.serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");

    const startsAt = new Date(input.startsAt);
    const endsAt = addMinutes(startsAt, service.durationMin);

    const eligibleStaff = await this.getEligibleStaff(service.id, input.staffId);
    if (eligibleStaff.length === 0) throw new Error("STAFF_NOT_ELIGIBLE");

    let assignedStaffId = input.staffId;
    if (!assignedStaffId) {
      for (const member of eligibleStaff) {
        const conflict = await salonRepository.listBlockedAppointments(member.id, startsAt, endsAt);
        if (conflict.length === 0) {
          assignedStaffId = member.id;
          break;
        }
      }
      if (!assignedStaffId) throw new Error("SLOT_NOT_AVAILABLE");
    } else {
      const conflict = await salonRepository.listBlockedAppointments(assignedStaffId, startsAt, endsAt);
      if (conflict.length > 0) throw new Error("SLOT_NOT_AVAILABLE");
    }

    const customer = await salonRepository.findOrCreateCustomerByEmail(
      input.customerEmail,
      input.locale,
      input.sourceChannel,
      {
        firstName: input.customerFirstName,
        lastName: input.customerLastName,
        phone: input.customerPhone,
      },
    );

    if (input.marketingOptIn !== undefined) {
      await salonRepository.updateCustomer(customer.id, { marketingOptIn: input.marketingOptIn });
      await salonRepository.recordConsent(customer.id, "marketing", input.marketingOptIn, "booking");
    }

    await salonRepository.recordConsent(customer.id, "terms", true, "booking");

    return salonRepository.createAppointment({
      customerId: customer.id,
      serviceId: service.id,
      staffId: assignedStaffId,
      startsAt,
      endsAt,
      locale: input.locale,
      sourceChannel: input.sourceChannel,
    });
  }

  async reschedule(appointmentId: string, startsAtIso: string) {
    const appointment = await salonRepository.findAppointmentById(appointmentId);
    if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
    const startsAt = new Date(startsAtIso);
    const endsAt = addMinutes(startsAt, appointment.service.durationMin);

    if (appointment.staffId) {
      const eligible = await this.getEligibleStaff(appointment.serviceId, appointment.staffId);
      if (eligible.length === 0) throw new Error("STAFF_NOT_ELIGIBLE");
    }

    const conflict = await salonRepository.listBlockedAppointments(
      appointment.staffId ?? undefined,
      startsAt,
      endsAt,
    );
    if (conflict.some((item) => item.id !== appointmentId)) {
      throw new Error("SLOT_NOT_AVAILABLE");
    }
    return salonRepository.rescheduleAppointment(appointmentId, startsAt, endsAt);
  }

  async cancel(appointmentId: string, reason: string) {
    return salonRepository.updateAppointmentStatus(appointmentId, "cancelled", reason);
  }

  async confirm(appointmentId: string, reason = "payment confirmed") {
    return salonRepository.updateAppointmentStatus(appointmentId, "confirmed", reason);
  }

  async listUpcomingForReminders(withinHours = 24) {
    const now = new Date();
    const until = addHours(now, withinHours);
    return salonRepository.listAppointmentsBetween(now, until, ["pending", "confirmed"]);
  }
}
