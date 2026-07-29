import { BookingService, PricingService } from "@hair-simo/core";
import { salonRepository } from "@hair-simo/core";

const bookingService = new BookingService();
const pricingService = new PricingService();

const aliasToSlug: Array<{ match: RegExp; slug: string }> = [
  { match: /balayage|str[aä]hn|highlight|meches/i, slug: "balayage-straehnen" },
  { match: /damen|frau|women|donna|femme/i, slug: "damen-schnitt" },
  { match: /herren|mann|men|uomo|homme/i, slug: "herren-schnitt" },
  { match: /kinder|kind|child|bambin|enfant/i, slug: "kinder-schnitt" },
  { match: /behandlung|treatment|keratin|trattamento|soin/i, slug: "behandlung" },
  { match: /haircut-women|women-cut/i, slug: "damen-schnitt" },
  { match: /haircut-men|men-cut/i, slug: "herren-schnitt" },
];

function resolveServiceSlug(raw: string) {
  const value = raw.trim();
  if (!value) return "damen-schnitt";
  for (const entry of aliasToSlug) {
    if (entry.match.test(value)) return entry.slug;
  }
  return value;
}

export const aiTools = {
  checkAvailability: async (serviceId: string) => {
    try {
      const slug = resolveServiceSlug(serviceId);
      const day = new Date().toISOString();
      const slots = await bookingService.getAvailability(slug, day);
      if (slots.length === 0) return "Aktuell sind fuer diesen Service keine freien Slots verfuegbar.";
      const preview = slots
        .slice(0, 5)
        .map((slot) => new Date(slot.startsAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }))
        .join(", ");
      return `Freie Slots heute (${slots.length}): ${preview}. Buchung: /de/booking?service=${slug}`;
    } catch (error) {
      return `Verfuegbarkeit gerade nicht abrufbar (${error instanceof Error ? error.message : "error"}). Bitte oeffne /de/booking.`;
    }
  },
  createBooking: async (serviceId: string, customerId?: string) => {
    void customerId;
    const slug = resolveServiceSlug(serviceId);
    return `Ich kann die Buchung vorbereiten. Bitte nutze den Buchungsflow: /de/booking?service=${slug}`;
  },
  rescheduleBooking: async (appointmentId: string) => {
    return `Umbuchung moeglich. Bitte oeffne deinen Manage-Link oder gehe zu /de/manage und nutze die Termin-ID ${appointmentId}.`;
  },
  cancelBooking: async (appointmentId: string) => {
    return `Storno moeglich ueber den Manage-Link. Falls du willst, kann ich dir die Schritte fuer Termin ${appointmentId} geben.`;
  },
  getServiceInfo: async (serviceSlug: string) => {
    try {
      const slug = resolveServiceSlug(serviceSlug);
      const services = await salonRepository.listServices();
      const service = services.find((entry) => entry.slug === slug) ?? services[0];
      if (!service) return "Aktuell sind keine Leistungen hinterlegt. Bitte schau unter /de/services.";
      const pricing = await pricingService.getPricing({ serviceSlug: service.slug, depositPercentage: 30 });
      const name = service.translations.find((entry) => entry.locale === "de")?.name ?? service.slug;
      return `${name}: Gesamt ${(pricing.total.amountCents / 100).toFixed(2)} EUR, Anzahlung ${(pricing.deposit.amountCents / 100).toFixed(2)} EUR. Details: /de/services`;
    } catch (error) {
      return `Preisinfo gerade nicht abrufbar (${error instanceof Error ? error.message : "error"}). Bitte oeffne /de/services.`;
    }
  },
};
