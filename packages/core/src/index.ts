import { addMinutes, areIntervalsOverlapping } from "date-fns";
import { z } from "zod";

export type Money = { amountCents: number; currency: "EUR" };

export type Slot = { startsAt: Date; endsAt: Date };
export type AvailabilityInput = {
  serviceDurationMin: number;
  bufferAfterMin: number;
  intervalMin: number;
  dayStart: Date;
  dayEnd: Date;
  blocked: Slot[];
};

export type BookingInput = {
  customerId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  staffId?: string;
  locale: "de" | "it" | "fr" | "en";
};

export const bookingInputSchema = z.object({
  customerId: z.string().min(1),
  serviceId: z.string().min(1),
  startsAt: z.date(),
  endsAt: z.date(),
  staffId: z.string().min(1).optional(),
  locale: z.enum(["de", "it", "fr", "en"]),
});

export function calculateDeposit(total: Money, percentage: number): Money {
  const safePercentage = Math.min(100, Math.max(0, percentage));
  return {
    amountCents: Math.round((total.amountCents * safePercentage) / 100),
    currency: total.currency,
  };
}

export function calculateTotalPrice(basePriceCents: number, addonsCents: number[] = []): Money {
  const amountCents = addonsCents.reduce((sum, value) => sum + value, basePriceCents);
  return { amountCents, currency: "EUR" };
}

export function buildAvailabilitySlots(input: AvailabilityInput): Slot[] {
  const result: Slot[] = [];
  let cursor = new Date(input.dayStart);
  const durationWithBuffer = input.serviceDurationMin + input.bufferAfterMin;

  while (cursor < input.dayEnd) {
    const appointmentEnd = addMinutes(cursor, input.serviceDurationMin);
    const blockedEnd = addMinutes(cursor, durationWithBuffer);
    if (blockedEnd > input.dayEnd) break;
    const overlaps = input.blocked.some((entry) =>
      areIntervalsOverlapping(
        { start: cursor, end: blockedEnd },
        { start: entry.startsAt, end: entry.endsAt },
        { inclusive: true },
      ),
    );
    if (!overlaps) {
      result.push({ startsAt: new Date(cursor), endsAt: appointmentEnd });
    }
    cursor = addMinutes(cursor, input.intervalMin);
  }

  return result;
}

export type AppointmentRecord = BookingInput & { id: string; status: "pending" | "confirmed" | "cancelled" };

export class BookingEngine {
  private appointments: AppointmentRecord[] = [];

  list(): AppointmentRecord[] {
    return [...this.appointments];
  }

  create(input: BookingInput): AppointmentRecord {
    const parsed = bookingInputSchema.parse(input);
    const overlapping = this.appointments.some(
      (item) =>
        item.staffId &&
        parsed.staffId &&
        item.staffId === parsed.staffId &&
        item.status !== "cancelled" &&
        areIntervalsOverlapping(
          { start: item.startsAt, end: item.endsAt },
          { start: parsed.startsAt, end: parsed.endsAt },
          { inclusive: true },
        ),
    );
    if (overlapping) {
      throw new Error("SLOT_NOT_AVAILABLE");
    }
    const appointment: AppointmentRecord = {
      ...parsed,
      id: `apt_${this.appointments.length + 1}`,
      status: "pending",
    };
    this.appointments.push(appointment);
    return appointment;
  }

  reschedule(appointmentId: string, startsAt: Date, endsAt: Date): AppointmentRecord {
    const appointment = this.appointments.find((entry) => entry.id === appointmentId);
    if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
    appointment.startsAt = startsAt;
    appointment.endsAt = endsAt;
    appointment.status = "confirmed";
    return appointment;
  }

  cancel(appointmentId: string, reason: string): AppointmentRecord {
    const appointment = this.appointments.find((entry) => entry.id === appointmentId);
    if (!appointment) throw new Error("APPOINTMENT_NOT_FOUND");
    void reason;
    appointment.status = "cancelled";
    return appointment;
  }
}

export { AuthService, assertRole as assertAuthRole, hashPassword, type AuthSession } from "./auth-service";
export { BookingService } from "./booking-service";
export { NotificationService } from "./notification-service";
export { PricingService } from "./pricing-service";
export { RefundService } from "./refund-service";
export { salonRepository } from "./repositories";
