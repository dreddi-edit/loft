import type { Toolset } from "@hair-simo/ai";
import { BookingService, PricingService } from "@hair-simo/core";
import { salonRepository } from "@hair-simo/core";
import type { AppLocale } from "@hair-simo/i18n";
import { DEFAULT_LOCALE, getServiceTranslationName } from "@hair-simo/i18n";
import { SALON_TIME_ZONE, formatSalonClock, salonTodayKey } from "./web-datetime";

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

type ToolMessages = {
  noSlots: string;
  slots: (count: number, preview: string, bookingHref: string) => string;
  availabilityFailed: (reason: string, bookingHref: string) => string;
  bookingHint: (bookingHref: string) => string;
  rescheduleHint: (appointmentId: string, manageHref: string) => string;
  cancelHint: (appointmentId: string) => string;
  noServices: (servicesHref: string) => string;
  serviceInfo: (name: string, total: string, deposit: string, servicesHref: string) => string;
  serviceInfoFailed: (reason: string, servicesHref: string) => string;
};

const messages: Record<AppLocale, ToolMessages> = {
  de: {
    noSlots: "Heute sind fuer diesen Service leider keine freien Slots verfuegbar.",
    slots: (count, preview, bookingHref) =>
      `Freie Slots heute (${count}), Ortszeit Brixen (${SALON_TIME_ZONE}): ${preview}. Buchung: ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Verfuegbarkeit gerade nicht abrufbar (${reason}). Bitte oeffne ${bookingHref}.`,
    bookingHint: (bookingHref) =>
      `Ich kann die Buchung vorbereiten. Bitte nutze den Buchungsflow: ${bookingHref}`,
    rescheduleHint: (appointmentId, manageHref) =>
      `Umbuchung moeglich. Bitte oeffne deinen Manage-Link oder gehe zu ${manageHref} und nutze die Termin-ID ${appointmentId}.`,
    cancelHint: (appointmentId) =>
      `Storno moeglich ueber den Manage-Link. Falls du willst, kann ich dir die Schritte fuer Termin ${appointmentId} geben.`,
    noServices: (servicesHref) =>
      `Aktuell sind keine Leistungen hinterlegt. Bitte schau unter ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name}: Gesamt ${total} EUR, Anzahlung ${deposit} EUR. Details: ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Preisinfo gerade nicht abrufbar (${reason}). Bitte oeffne ${servicesHref}.`,
  },
  it: {
    noSlots: "Oggi purtroppo non ci sono orari liberi per questo servizio.",
    slots: (count, preview, bookingHref) =>
      `Orari liberi oggi (${count}), ora locale di Bressanone (${SALON_TIME_ZONE}): ${preview}. Prenotazione: ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Disponibilita non consultabile al momento (${reason}). Apri ${bookingHref}.`,
    bookingHint: (bookingHref) =>
      `Posso preparare la prenotazione. Usa il flusso di prenotazione: ${bookingHref}`,
    rescheduleHint: (appointmentId, manageHref) =>
      `La riprogrammazione e possibile. Apri il tuo link di gestione oppure vai su ${manageHref} e usa il codice appuntamento ${appointmentId}.`,
    cancelHint: (appointmentId) =>
      `Puoi annullare tramite il link di gestione. Se vuoi ti spiego i passaggi per l'appuntamento ${appointmentId}.`,
    noServices: (servicesHref) =>
      `Al momento non ci sono servizi registrati. Dai un'occhiata a ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name}: totale ${total} EUR, acconto ${deposit} EUR. Dettagli: ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Informazioni sui prezzi non disponibili al momento (${reason}). Apri ${servicesHref}.`,
  },
  fr: {
    noSlots: "Aujourd'hui il n'y a malheureusement aucun creneau libre pour ce service.",
    slots: (count, preview, bookingHref) =>
      `Creneaux libres aujourd'hui (${count}), heure locale de Bressanone (${SALON_TIME_ZONE}) : ${preview}. Reservation : ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Disponibilites indisponibles pour le moment (${reason}). Merci d'ouvrir ${bookingHref}.`,
    bookingHint: (bookingHref) =>
      `Je peux preparer la reservation. Merci d'utiliser le parcours de reservation : ${bookingHref}`,
    rescheduleHint: (appointmentId, manageHref) =>
      `Le report est possible. Ouvrez votre lien de gestion ou allez sur ${manageHref} avec la reference ${appointmentId}.`,
    cancelHint: (appointmentId) =>
      `L'annulation passe par le lien de gestion. Si vous voulez, je vous donne les etapes pour le rendez-vous ${appointmentId}.`,
    noServices: (servicesHref) =>
      `Aucune prestation n'est enregistree pour le moment. Consultez ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name} : total ${total} EUR, acompte ${deposit} EUR. Details : ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Tarifs indisponibles pour le moment (${reason}). Merci d'ouvrir ${servicesHref}.`,
  },
  en: {
    noSlots: "There are no free slots for this service today.",
    slots: (count, preview, bookingHref) =>
      `Free slots today (${count}), Brixen local time (${SALON_TIME_ZONE}): ${preview}. Booking: ${bookingHref}`,
    availabilityFailed: (reason, bookingHref) =>
      `Availability is not reachable right now (${reason}). Please open ${bookingHref}.`,
    bookingHint: (bookingHref) =>
      `I can prepare the booking. Please use the booking flow: ${bookingHref}`,
    rescheduleHint: (appointmentId, manageHref) =>
      `Rescheduling is possible. Open your manage link or go to ${manageHref} and use the appointment id ${appointmentId}.`,
    cancelHint: (appointmentId) =>
      `Cancelling works through the manage link. If you like, I can walk you through it for appointment ${appointmentId}.`,
    noServices: (servicesHref) =>
      `No services are configured right now. Please check ${servicesHref}.`,
    serviceInfo: (name, total, deposit, servicesHref) =>
      `${name}: total ${total} EUR, deposit ${deposit} EUR. Details: ${servicesHref}`,
    serviceInfoFailed: (reason, servicesHref) =>
      `Price info is not reachable right now (${reason}). Please open ${servicesHref}.`,
  },
};

function resolveServiceSlug(raw: string) {
  const value = raw.trim();
  if (!value) return "damen-schnitt";
  for (const entry of aliasToSlug) {
    if (entry.match.test(value)) return entry.slug;
  }
  return value;
}

function reasonOf(error: unknown) {
  return error instanceof Error ? error.message : "error";
}

function euro(amountCents: number) {
  return (amountCents / 100).toFixed(2);
}

/**
 * The assistant answers in the caller's language and in salon time. `Toolset` in
 * @hair-simo/ai carries no locale, so the locale is bound here when the toolset is
 * built; a route that knows the request locale should call this instead of using the
 * `aiTools` default.
 */
export function createAiTools(locale: AppLocale = DEFAULT_LOCALE): Toolset {
  const copy = messages[locale];
  const bookingHref = (slug: string) => `/${locale}/booking?service=${slug}`;
  const manageHref = `/${locale}/manage`;
  const servicesHref = `/${locale}/services`;

  return {
    checkAvailability: async (serviceId: string) => {
      const slug = resolveServiceSlug(serviceId);
      try {
        const slots = await bookingService.getAvailability(slug, salonTodayKey());
        if (slots.length === 0) return copy.noSlots;
        const preview = slots
          .slice(0, 5)
          .map((slot) => formatSalonClock(slot.startsAt, locale))
          .join(", ");
        return copy.slots(slots.length, preview, bookingHref(slug));
      } catch (error) {
        return copy.availabilityFailed(reasonOf(error), bookingHref(slug));
      }
    },
    createBooking: async (serviceId: string, customerId?: string) => {
      void customerId;
      return copy.bookingHint(bookingHref(resolveServiceSlug(serviceId)));
    },
    rescheduleBooking: async (appointmentId: string) => {
      return copy.rescheduleHint(appointmentId, manageHref);
    },
    cancelBooking: async (appointmentId: string) => {
      return copy.cancelHint(appointmentId);
    },
    getServiceInfo: async (serviceSlug: string) => {
      try {
        const slug = resolveServiceSlug(serviceSlug);
        const services = await salonRepository.listServices();
        const service = services.find((entry) => entry.slug === slug) ?? services[0];
        if (!service) return copy.noServices(servicesHref);
        const pricing = await pricingService.getPricing({
          serviceSlug: service.slug,
          depositPercentage: 30,
        });
        const name = getServiceTranslationName(
          service.translations,
          locale,
          service.translations.find((entry) => entry.locale === "de")?.name ?? service.slug,
        );
        return copy.serviceInfo(
          name,
          euro(pricing.total.amountCents),
          euro(pricing.deposit.amountCents),
          servicesHref,
        );
      } catch (error) {
        return copy.serviceInfoFailed(reasonOf(error), servicesHref);
      }
    },
  };
}

export const aiTools = createAiTools();
