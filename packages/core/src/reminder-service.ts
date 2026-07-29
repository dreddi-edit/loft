import { resolveLocale } from "@hair-simo/i18n";
import { NotificationService } from "./notification-service";
import { BookingService } from "./booking-service";
import { formatSalonTimeRange } from "./time";
import type { Channel } from "@hair-simo/db";
import type { DeliveryStatus } from "./notification-service";

const MAX_WITHIN_HOURS = 24 * 7;

type ReminderCustomer = {
  email: string | null;
  phone: string | null;
  deletedAt: Date | null;
  anonymizedAt: Date | null;
};

type ReminderTarget = { channel: Channel; recipient: string };

export type ReminderDispatchEntry = {
  appointmentId: string;
  notificationId: string | null;
  status: DeliveryStatus | "unreachable";
  reason?: string;
};

/**
 * Email goes out over Gmail, which the Channel enum spells `web` (it has no `email`
 * member); everything else falls back to the phone number over `sms`. A customer with
 * neither, or one that was erased on request, is skipped instead of throwing.
 */
function resolveTarget(customer: ReminderCustomer): ReminderTarget | null {
  if (customer.deletedAt || customer.anonymizedAt) return null;
  const email = customer.email?.trim();
  if (email) return { channel: "web", recipient: email };
  const phone = customer.phone?.trim();
  if (phone) return { channel: "sms", recipient: phone };
  return null;
}

function normalizeWithinHours(withinHours: number): number {
  if (!Number.isFinite(withinHours) || withinHours <= 0) return 24;
  return Math.min(withinHours, MAX_WITHIN_HOURS);
}

export class ReminderService {
  private bookingService = new BookingService();
  private notificationService = new NotificationService();

  async dispatchDueReminders(withinHours = 24) {
    const appointments = await this.bookingService.listUpcomingForReminders(
      normalizeWithinHours(withinHours),
    );

    const candidates = appointments.map((appointment) => ({
      appointment,
      target: resolveTarget(appointment.customer),
    }));
    const reachable = candidates.flatMap(({ appointment, target }) =>
      target ? [{ appointment, target }] : [],
    );

    const blocked = await this.notificationService.listAppointmentsWithBlockedReminder(
      reachable.map((entry) => entry.appointment.id),
    );

    const results: ReminderDispatchEntry[] = candidates
      .filter((entry) => entry.target === null)
      .map((entry) => ({
        appointmentId: entry.appointment.id,
        notificationId: null,
        status: "unreachable" as const,
        reason: "NO_CONTACT_DETAILS",
      }));

    for (const { appointment, target } of reachable) {
      if (blocked.has(appointment.id)) {
        results.push({
          appointmentId: appointment.id,
          notificationId: null,
          status: "skipped",
          reason: "REMINDER_ALREADY_HANDLED",
        });
        continue;
      }

      const locale = resolveLocale(appointment.locale);
      const { record, delivery } = await this.notificationService.sendAppointmentReminder({
        appointmentId: appointment.id,
        channel: target.channel,
        recipient: target.recipient,
        locale,
        timeLabel: formatSalonTimeRange(appointment.startsAt, appointment.endsAt, locale),
      });
      results.push({
        appointmentId: appointment.id,
        notificationId: record?.id ?? null,
        status: delivery.status,
        reason: delivery.reason,
      });
    }

    const counted = (status: ReminderDispatchEntry["status"]) =>
      results.filter((entry) => entry.status === status).length;

    return {
      processed: results.length,
      sent: counted("sent"),
      simulated: counted("simulated"),
      failed: counted("failed"),
      skipped: counted("skipped"),
      unreachable: counted("unreachable"),
      results,
    };
  }
}
