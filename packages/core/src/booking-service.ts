import { addMinutes, endOfDay, startOfDay } from "date-fns";
import { z } from "zod";
import { buildAvailabilitySlots } from "./index";
import { salonRepository } from "./repositories";

const bookingRequestSchema = z.object({
  serviceSlug: z.string().min(1),
  startsAt: z.string().datetime(),
  customerEmail: z.string().email(),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
  sourceChannel: z.enum(["web", "whatsapp", "sms", "voice"]).default("web"),
  staffId: z.string().optional(),
});

export class BookingService {
  async getAvailability(serviceSlug: string, dayIso: string, staffId?: string) {
    const service = await salonRepository.findServiceBySlug(serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");
    const day = new Date(dayIso);
    const dayStart = startOfDay(day);
    const dayEnd = endOfDay(day);
    const blocked = await salonRepository.listBlockedAppointments(staffId, dayStart, dayEnd);

    return buildAvailabilitySlots({
      serviceDurationMin: service.durationMin,
      bufferAfterMin: service.bufferAfterMin,
      intervalMin: 15,
      dayStart,
      dayEnd,
      blocked: blocked.map((item) => ({ startsAt: item.startsAt, endsAt: item.endsAt })),
    });
  }

  async createBooking(rawInput: unknown) {
    const input = bookingRequestSchema.parse(rawInput);
    const service = await salonRepository.findServiceBySlug(input.serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");

    const startsAt = new Date(input.startsAt);
    const endsAt = addMinutes(startsAt, service.durationMin);
    const conflict = await salonRepository.listBlockedAppointments(input.staffId, startsAt, endsAt);
    if (conflict.length > 0) throw new Error("SLOT_NOT_AVAILABLE");

    const customer = await salonRepository.findOrCreateCustomerByEmail(
      input.customerEmail,
      input.locale,
      input.sourceChannel,
    );

    return salonRepository.createAppointment({
      customerId: customer.id,
      serviceId: service.id,
      staffId: input.staffId,
      startsAt,
      endsAt,
      locale: input.locale,
      sourceChannel: input.sourceChannel,
    });
  }

  async reschedule(appointmentId: string, startsAtIso: string) {
    const startsAt = new Date(startsAtIso);
    return salonRepository.rescheduleAppointment(appointmentId, startsAt, addMinutes(startsAt, 60));
  }

  async cancel(appointmentId: string, reason: string) {
    return salonRepository.updateAppointmentStatus(appointmentId, "cancelled", reason);
  }
}
