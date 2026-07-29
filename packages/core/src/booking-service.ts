import { addHours, addMinutes } from "date-fns";
import { z } from "zod";
import {
  buildSalonWindow,
  buildSlotsForWindow,
  intersectWindows,
  mergeUniqueSlots,
  type AvailabilityWindow,
  type BlockedInterval,
} from "./availability-engine";
import { salonRepository } from "./repositories";
import { endOfSalonDay, parseSalonDay, salonDayOfWeek, startOfSalonDay } from "./time";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const SALON_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How far in advance a slot has to be booked. Two hours is what the salon needs to see
 * the booking at all, to mix colour for a chemical service and to stop a customer from
 * claiming a chair someone is already sitting in — the online calendar is not a walk-in
 * queue. It is still short enough to keep same-afternoon bookings possible.
 */
export const MIN_BOOKING_LEAD_MINUTES = 120;

/**
 * How far ahead the calendar is open. Six months is one full rota planning cycle: past
 * that the staff roster, the opening hours and the price list are not decided yet, so a
 * booking taken today could not be honoured as quoted. It also bounds the damage from a
 * script hammering the endpoint with far-future dates.
 */
export const MAX_BOOKING_HORIZON_DAYS = 180;

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

/**
 * A salon day is addressed either by its plain key ("2026-08-04", what the date picker
 * actually holds) or by a full ISO instant, which is what older clients send after
 * guessing a UTC anchor. Anything else is rejected before it can become an Invalid Date.
 */
const availabilityDaySchema = z.union([
  z.string().trim().regex(SALON_DAY_KEY_PATTERN),
  z.string().trim().datetime({ offset: true }),
]);

type ServiceTiming = { durationMin: number; bufferAfterMin: number };

type StaffDayPlan = {
  rules: { startMin: number; endMin: number }[];
  blocked: BlockedInterval[];
};

type SalonDayContext = {
  dayStart: Date;
  businessWindow: AvailabilityWindow | null;
  staff: Map<string, StaffDayPlan>;
};

export function resolveSalonDayInput(rawDay: string): Date {
  const parsed = availabilityDaySchema.safeParse(rawDay);
  if (!parsed.success) throw new Error("INVALID_DAY");
  if (SALON_DAY_KEY_PATTERN.test(parsed.data)) {
    try {
      return parseSalonDay(parsed.data);
    } catch {
      throw new Error("INVALID_DAY");
    }
  }
  const instant = new Date(parsed.data);
  if (Number.isNaN(instant.getTime())) throw new Error("INVALID_DAY");
  return startOfSalonDay(instant);
}

export function earliestBookableStart(now: Date): Date {
  return new Date(now.getTime() + MIN_BOOKING_LEAD_MINUTES * MS_PER_MINUTE);
}

/** Exclusive upper bound: the first instant of the salon day after the last open one. */
export function bookingHorizonEnd(now: Date): Date {
  return endOfSalonDay(new Date(now.getTime() + MAX_BOOKING_HORIZON_DAYS * MS_PER_DAY));
}

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

  /**
   * Every query the slot maths of one salon day needs, for all requested staff at once.
   * Opening hours and the appointment book are fetched once per day rather than once per
   * staff member, and the per-staff reads run in parallel instead of one round trip after
   * another.
   */
  private async loadSalonDayContext(input: {
    day: Date;
    staffIds: string[];
    excludeAppointmentId?: string;
  }): Promise<SalonDayContext> {
    const dayStart = startOfSalonDay(input.day);
    const dayEnd = endOfSalonDay(input.day);
    const dayOfWeek = salonDayOfWeek(input.day);

    const [businessHours, appointments, staffDays] = await Promise.all([
      salonRepository.listBusinessHours(),
      salonRepository.listBlockedAppointments(undefined, dayStart, dayEnd),
      Promise.all(
        input.staffIds.map((staffId) =>
          Promise.all([
            salonRepository.listStaffAvailability(staffId),
            salonRepository.listStaffTimeOff(staffId, dayStart, dayEnd),
          ]).then(([rules, timeOffs]) => ({ staffId, rules, timeOffs })),
        ),
      ),
    ]);

    const business = businessHours.find((entry) => entry.dayOfWeek === dayOfWeek);
    const businessWindow =
      business && business.isOpen
        ? buildSalonWindow(dayStart, business.startMin, business.endMin)
        : null;

    const appointmentsByStaff = new Map<string, BlockedInterval[]>();
    for (const appointment of appointments) {
      if (!appointment.staffId) continue;
      if (appointment.id === input.excludeAppointmentId) continue;
      const entries = appointmentsByStaff.get(appointment.staffId) ?? [];
      entries.push({
        startsAt: appointment.startsAt,
        endsAt: addMinutes(appointment.endsAt, appointment.service.bufferAfterMin),
      });
      appointmentsByStaff.set(appointment.staffId, entries);
    }

    const staff = new Map<string, StaffDayPlan>();
    for (const entry of staffDays) {
      staff.set(entry.staffId, {
        rules: entry.rules.filter((rule) => rule.dayOfWeek === dayOfWeek),
        blocked: [
          ...(appointmentsByStaff.get(entry.staffId) ?? []),
          ...entry.timeOffs.map((item) => ({ startsAt: item.startsAt, endsAt: item.endsAt })),
        ],
      });
    }

    return { dayStart, businessWindow, staff };
  }

  private slotsForStaff(context: SalonDayContext, service: ServiceTiming, staffId: string) {
    const businessWindow = context.businessWindow;
    if (!businessWindow) return [];
    const plan = context.staff.get(staffId);
    if (!plan || plan.rules.length === 0) return [];

    const slots = plan.rules.flatMap((rule) => {
      const window = intersectWindows(
        businessWindow,
        buildSalonWindow(context.dayStart, rule.startMin, rule.endMin),
      );
      if (!window) return [];
      return buildSlotsForWindow({
        window,
        serviceDurationMin: service.durationMin,
        bufferAfterMin: service.bufferAfterMin,
        blocked: plan.blocked,
      });
    });

    return mergeUniqueSlots(slots);
  }

  /**
   * The single availability decision shared by createBooking and reschedule: who may do
   * this service, and which of them actually has the requested instant free. Both callers
   * go through here so the offered slots and the accepted bookings cannot drift apart.
   */
  private async resolveSlotCandidates(input: {
    service: ServiceTiming;
    serviceId: string;
    startsAt: Date;
    requestedStaffId?: string;
    excludeAppointmentId?: string;
  }): Promise<{ eligible: string[]; available: string[] }> {
    const eligible = await this.getEligibleStaff(input.serviceId, input.requestedStaffId);
    const staffIds = eligible.map((member) => member.id);
    if (staffIds.length === 0) return { eligible: staffIds, available: [] };

    const context = await this.loadSalonDayContext({
      day: input.startsAt,
      staffIds,
      excludeAppointmentId: input.excludeAppointmentId,
    });
    const target = input.startsAt.getTime();
    const available = staffIds.filter((staffId) =>
      this.slotsForStaff(context, input.service, staffId).some(
        (slot) => slot.startsAt.getTime() === target,
      ),
    );
    return { eligible: staffIds, available };
  }

  private assertBookableInstant(startsAt: Date, now = new Date()) {
    if (Number.isNaN(startsAt.getTime())) throw new Error("INVALID_START");
    if (startsAt < earliestBookableStart(now)) throw new Error("BOOKING_TOO_SOON");
    if (startsAt >= bookingHorizonEnd(now)) throw new Error("BOOKING_TOO_FAR_AHEAD");
  }

  async getAvailability(serviceSlug: string, dayIso: string, staffId?: string) {
    const service = await salonRepository.findServiceBySlug(serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");

    const day = resolveSalonDayInput(dayIso);
    const staffMembers = await this.getEligibleStaff(service.id, staffId);

    if (staffMembers.length === 0) {
      if (staffId) throw new Error("STAFF_NOT_ELIGIBLE");
      return [];
    }

    const staffIds = staffMembers.map((member) => member.id);
    const context = await this.loadSalonDayContext({ day, staffIds });
    const slots = mergeUniqueSlots(
      staffIds.flatMap((id) => this.slotsForStaff(context, service, id)),
    );

    const now = new Date();
    const earliest = earliestBookableStart(now);
    const horizon = bookingHorizonEnd(now);
    return slots.filter((slot) => slot.startsAt >= earliest && slot.startsAt < horizon);
  }

  async createBooking(rawInput: unknown) {
    const input = bookingRequestSchema.parse(rawInput);
    const service = await salonRepository.findServiceBySlug(input.serviceSlug);
    if (!service) throw new Error("SERVICE_NOT_FOUND");

    const startsAt = new Date(input.startsAt);
    const endsAt = addMinutes(startsAt, service.durationMin);
    const blockedEndsAt = addMinutes(endsAt, service.bufferAfterMin);
    this.assertBookableInstant(startsAt);

    const { eligible, available } = await this.resolveSlotCandidates({
      service,
      serviceId: service.id,
      startsAt,
      requestedStaffId: input.staffId,
    });
    if (eligible.length === 0) throw new Error("STAFF_NOT_ELIGIBLE");
    if (available.length === 0) throw new Error("SLOT_NOT_AVAILABLE");

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

    for (const staffId of available) {
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
    this.assertBookableInstant(startsAt);

    const { available } = await this.resolveSlotCandidates({
      service: appointment.service,
      serviceId: appointment.serviceId,
      startsAt,
      requestedStaffId: appointment.staffId ?? undefined,
      excludeAppointmentId: appointmentId,
    });

    for (const staffId of available) {
      try {
        return await salonRepository.rescheduleAppointmentIfAvailable(
          appointmentId,
          staffId,
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
