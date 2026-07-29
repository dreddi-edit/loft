import { addHours, addMinutes, endOfDay, startOfDay } from "date-fns";
import { z } from "zod";
import {
  buildSlotsForWindow,
  intersectWindows,
  mergeUniqueSlots,
  minutesToDate,
} from "./availability-engine";
import { salonRepository } from "./repositories";

const bookingRequestSchema = z
  .object({
    serviceSlug: z.string().trim().min(1).max(100),
    startsAt: z.string().datetime(),
    customerEmail: z.string().trim().email().max(254),
    customerFirstName: z.string().trim().min(1).max(100).optional(),
    customerLastName: z.string().trim().min(1).max(100).optional(),
    customerPhone: z.string().trim().max(30).optional(),
    locale: z.enum(["de", "it", "fr", "en"]).default("en"),
    sourceChannel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
    staffId: z.string().trim().min(1).optional(),
    marketingOptIn: z.boolean().optional(),
    termsAccepted: z.literal(true),
  })
  .strict();

const rescheduleSchema = z.string().datetime();

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
    excludeAppointmentId?: string,
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
      ...appointments
        .filter((item) => item.id !== excludeAppointmentId)
        .map((item) => ({
          startsAt: item.startsAt,
          endsAt: addMinutes(item.endsAt, item.service.bufferAfterMin),
        })),
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

  private async isStaffAvailable(
    service: { durationMin: number; bufferAfterMin: number },
    staffId: string,
    startsAt: Date,
    excludeAppointmentId?: string,
  ) {
    const slots = await this.getAvailabilityForStaff(
      service,
      staffId,
      startsAt,
      excludeAppointmentId,
    );
    return slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime());
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
    const service = await salonRepository.findServiceBySlug(input.serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");

    const startsAt = new Date(input.startsAt);
    const endsAt = addMinutes(startsAt, service.durationMin);
    const blockedEndsAt = addMinutes(endsAt, service.bufferAfterMin);
    if (startsAt <= new Date()) throw new Error("SLOT_NOT_AVAILABLE");

    const eligibleStaff = await this.getEligibleStaff(service.id, input.staffId);
    if (eligibleStaff.length === 0) throw new Error("STAFF_NOT_ELIGIBLE");

    const availableStaff = [];
    for (const member of eligibleStaff) {
      if (await this.isStaffAvailable(service, member.id, startsAt)) availableStaff.push(member.id);
    }
    if (availableStaff.length === 0) throw new Error("SLOT_NOT_AVAILABLE");

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
      await salonRepository.recordConsent(
        customer.id,
        "marketing",
        input.marketingOptIn,
        "booking",
      );
    }

    await salonRepository.recordConsent(customer.id, "terms", true, "booking");

    for (const staffId of availableStaff) {
      try {
        return await salonRepository.createAppointmentIfAvailable({
          customerId: customer.id,
          serviceId: service.id,
          staffId,
          startsAt,
          endsAt,
          blockedEndsAt,
          locale: input.locale,
          sourceChannel: input.sourceChannel,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "SLOT_NOT_AVAILABLE" && !input.staffId)
          continue;
        throw error;
      }
    }
    throw new Error("SLOT_NOT_AVAILABLE");
  }

  async reschedule(appointmentId: string, startsAtIso: string) {
    rescheduleSchema.parse(startsAtIso);
    const appointment = await salonRepository.findAppointmentById(appointmentId);
    if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
    const startsAt = new Date(startsAtIso);
    const endsAt = addMinutes(startsAt, appointment.service.durationMin);
    const blockedEndsAt = addMinutes(endsAt, appointment.service.bufferAfterMin);
    if (startsAt <= new Date()) throw new Error("SLOT_NOT_AVAILABLE");

    const eligible = await this.getEligibleStaff(
      appointment.serviceId,
      appointment.staffId ?? undefined,
    );
    for (const member of eligible) {
      if (!(await this.isStaffAvailable(appointment.service, member.id, startsAt, appointmentId))) {
        continue;
      }
      try {
        return await salonRepository.rescheduleAppointmentIfAvailable(
          appointmentId,
          member.id,
          startsAt,
          endsAt,
          blockedEndsAt,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "SLOT_NOT_AVAILABLE" &&
          !appointment.staffId
        )
          continue;
        throw error;
      }
    }
    throw new Error("SLOT_NOT_AVAILABLE");
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
