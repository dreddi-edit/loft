import { NotificationService } from "./notification-service";
import { BookingService } from "./booking-service";

export class ReminderService {
  private bookingService = new BookingService();
  private notificationService = new NotificationService();

  async dispatchDueReminders(withinHours = 24) {
    const appointments = await this.bookingService.listUpcomingForReminders(withinHours);
    const results = [];

    for (const appointment of appointments) {
      const recipient = appointment.customer.email ?? appointment.customer.phone;
      if (!recipient) continue;

      const alreadySent = await this.notificationService.wasReminderSent(appointment.id);
      if (alreadySent) continue;

      const channel = appointment.customer.email ? ("web" as const) : ("sms" as const);
      const result = await this.notificationService.sendAppointmentReminder({
        appointmentId: appointment.id,
        channel,
        recipient,
        locale: (appointment.locale as "de" | "it" | "fr" | "en") ?? "en",
        timeLabel: new Date(appointment.startsAt).toLocaleString(appointment.locale),
      });
      results.push(result);
    }

    return { processed: results.length, results };
  }
}
