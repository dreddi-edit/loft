import { BookingService, PricingService } from "@hair-simo/core";

const bookingService = new BookingService();
const pricingService = new PricingService();

export const aiTools = {
  checkAvailability: async (serviceId: string) => {
    const slots = await bookingService.getAvailability(serviceId, new Date().toISOString());
    return `${slots.length} slots available today`;
  },
  createBooking: async (serviceId: string, customerId?: string) => {
    void customerId;
    const booking = await bookingService.createBooking({
      serviceSlug: serviceId,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      customerEmail: "chat-user@example.com",
      locale: "en",
      sourceChannel: "web",
    });
    return `Booking created: ${booking.id}`;
  },
  rescheduleBooking: async (appointmentId: string) => {
    const rescheduled = await bookingService.reschedule(
      appointmentId,
      new Date(Date.now() + 172_800_000).toISOString(),
    );
    return `Booking rescheduled: ${rescheduled.id}`;
  },
  cancelBooking: async (appointmentId: string) => {
    const cancelled = await bookingService.cancel(appointmentId, "AI assisted cancellation");
    return `Booking cancelled: ${cancelled.id}`;
  },
  getServiceInfo: async (serviceSlug: string) => {
    const pricing = await pricingService.getPricing({ serviceSlug, depositPercentage: 30 });
    return `Service ${serviceSlug}: total ${(pricing.total.amountCents / 100).toFixed(2)} EUR`;
  },
};
