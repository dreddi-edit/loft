import { randomUUID } from "node:crypto";
import {
  createBookingToolset,
  type AppointmentSummary,
  type BookingBackend,
  type CreateBookingInput,
  type ServiceSummary,
  type ToolChannel,
  type ToolLinks,
  type Toolset,
} from "@hair-simo/ai";
import { BookingService, PricingService, salonRepository } from "@hair-simo/core";
import { formatSalonTimeRange, salonDayKey, verifyAppointmentAccessToken } from "@hair-simo/core";
import type { AppLocale } from "@hair-simo/i18n";
import { DEFAULT_LOCALE, getServiceTranslationName } from "@hair-simo/i18n";
import { contactInfo } from "./site-content";
import {
  SALON_TIME_ZONE,
  formatSalonClock,
  formatSalonDateTime,
  fromSalonWallClock,
  salonTodayKey,
} from "./web-datetime";

const bookingService = new BookingService();
const pricingService = new PricingService();

/** Bounds the pricing fan-out of the "what do you offer" answer. */
const MAX_LISTED_SERVICES = 12;

const aliasToSlug: Array<{ match: RegExp; slug: string }> = [
  { match: /balayage|str[aä]hn|highlight|meches/i, slug: "balayage-straehnen" },
  { match: /damen|frau|women|donna|femme/i, slug: "damen-schnitt" },
  { match: /herren|mann|men|uomo|homme/i, slug: "herren-schnitt" },
  { match: /kinder|kind|child|bambin|enfant/i, slug: "kinder-schnitt" },
  { match: /behandlung|treatment|keratin|trattamento|soin/i, slug: "behandlung" },
  { match: /haircut-women|women-cut/i, slug: "damen-schnitt" },
  { match: /haircut-men|men-cut/i, slug: "herren-schnitt" },
];

type ServiceRow = {
  slug: string;
  durationMin: number;
  translations: { locale: string; name: string }[];
};

function serviceName(service: ServiceRow, locale: AppLocale): string {
  return getServiceTranslationName(
    service.translations,
    locale,
    service.translations.find((entry) => entry.locale === "de")?.name ?? service.slug,
  );
}

async function toServiceSummary(service: ServiceRow, locale: AppLocale): Promise<ServiceSummary> {
  const pricing = await pricingService.getPricing({ serviceSlug: service.slug });
  return {
    slug: service.slug,
    name: serviceName(service, locale),
    durationMin: service.durationMin,
    totalCents: pricing.total.amountCents,
    depositCents: pricing.deposit.amountCents,
    depositRequired: pricing.depositRequired,
  };
}

/**
 * Maps whatever the customer said onto a slug. Unlike the previous version this returns
 * nothing when it does not recognise the service: silently defaulting to "damen-schnitt"
 * was harmless while the tools only produced text, and books the wrong service now that
 * they do not.
 */
function candidateSlug(reference: string): string | null {
  const value = reference.trim();
  if (!value) return null;
  for (const entry of aliasToSlug) {
    if (entry.match.test(value)) return entry.slug;
  }
  return /^[a-z0-9-]{1,100}$/i.test(value) ? value.toLowerCase() : null;
}

function appointmentSummary(
  appointment: {
    id: string;
    customerId: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    service: { slug: string };
    staff?: { displayName: string } | null;
  },
  name: string,
  locale: AppLocale,
): AppointmentSummary {
  return {
    id: appointment.id,
    customerId: appointment.customerId,
    startsAt: appointment.startsAt.toISOString(),
    status: appointment.status,
    serviceSlug: appointment.service.slug,
    serviceName: name,
    ...(appointment.staff?.displayName ? { staffName: appointment.staff.displayName } : {}),
    when: formatSalonTimeRange(appointment.startsAt, appointment.endsAt, locale),
  };
}

/**
 * The database half of the assistant's tools. @hair-simo/ai owns the policy — token
 * checks, read-back, confirmation codes, rate limits — and never sees Prisma; this
 * adapter owns the queries and every conversion between a salon wall clock and an
 * instant, which is why all of it goes through @hair-simo/core.
 */
export function createBookingBackend(locale: AppLocale): BookingBackend {
  return {
    listServices: async () => {
      const services = await salonRepository.listServices();
      return Promise.all(
        services.slice(0, MAX_LISTED_SERVICES).map((service) => toServiceSummary(service, locale)),
      );
    },

    findService: async (reference) => {
      const slug = candidateSlug(reference);
      if (slug) {
        const direct = await salonRepository.findServiceBySlug(slug);
        if (direct && direct.isActive) return toServiceSummary(direct, locale);
      }
      const needle = reference.trim().toLowerCase();
      if (needle.length < 3) return null;
      const services = await salonRepository.listServices();
      const match = services.find((service) =>
        service.translations.some((entry) => entry.name.toLowerCase().includes(needle)),
      );
      return match ? toServiceSummary(match, locale) : null;
    },

    listBusinessHours: async () => {
      const hours = await salonRepository.listBusinessHours();
      return hours.map((entry) => ({
        dayOfWeek: entry.dayOfWeek,
        isOpen: entry.isOpen,
        startMin: entry.startMin,
        endMin: entry.endMin,
      }));
    },

    listAvailability: async (serviceSlug, dayKey) => {
      const slots = await bookingService.getAvailability(serviceSlug, dayKey);
      return slots.map((slot) => ({
        startsAt: slot.startsAt.toISOString(),
        label: formatSalonClock(slot.startsAt, locale),
      }));
    },

    todayKey: (now) => salonTodayKey(now),

    dayKeyOf: (instantIso) => salonDayKey(new Date(instantIso)),

    resolveInstant: (dayKey, clock) => {
      const [rawHour, rawMinute] = clock.split(":");
      const padded = `${rawHour.padStart(2, "0")}:${rawMinute.padStart(2, "0")}`;
      return fromSalonWallClock(`${dayKey}T${padded}`).toISOString();
    },

    verifyAccessToken: (token) => verifyAppointmentAccessToken(token),

    findAppointment: async (appointmentId) => {
      const appointment = await salonRepository.findAppointmentById(appointmentId);
      if (!appointment) return null;
      return appointmentSummary(appointment, serviceName(appointment.service, locale), locale);
    },

    createBooking: async (input: CreateBookingInput) => {
      const appointment = await bookingService.createBooking({
        serviceSlug: input.serviceSlug,
        startsAt: input.startsAt,
        customerEmail: input.email,
        customerFirstName: input.firstName,
        customerLastName: input.lastName,
        customerPhone: input.phone,
        locale: input.locale,
        sourceChannel: input.channel,
        marketingOptIn: input.marketingOptIn,
        termsAccepted: true,
      });
      if (input.note) {
        await salonRepository.addCustomerNote(appointment.customerId, input.note, {
          kind: "general",
        });
      }
      const service = await salonRepository.findServiceBySlug(input.serviceSlug);
      return appointmentSummary(
        appointment,
        service ? serviceName(service, locale) : input.serviceSlug,
        locale,
      );
    },

    rescheduleAppointment: async (appointmentId, startsAtIso) => {
      const appointment = await bookingService.reschedule(appointmentId, startsAtIso);
      const service = await salonRepository.findServiceBySlug(appointment.service.slug);
      return appointmentSummary(
        appointment,
        service ? serviceName(service, locale) : appointment.service.slug,
        locale,
      );
    },

    cancelAppointment: async (appointmentId, reason) => {
      const appointment = await bookingService.cancel(appointmentId, reason);
      const service = await salonRepository.findServiceBySlug(appointment.service.slug);
      return appointmentSummary(
        appointment,
        service ? serviceName(service, locale) : appointment.service.slug,
        locale,
      );
    },

    recordConsent: async (input) =>
      void (await salonRepository.recordConsent(
        input.customerId,
        input.type,
        input.granted,
        input.source,
      )),

    formatInstant: (instantIso) => formatSalonDateTime(instantIso, locale),
  };
}

export type AiToolsOptions = {
  locale?: AppLocale;
  channel?: ToolChannel;
  /**
   * Server-derived key for the multi-turn booking draft. It must never be something the
   * caller can pick for another person; the routes build it from the resolved client
   * address plus an opaque server-issued chat id. Omitting it gives this request its own
   * private draft, so a caller without one can still book — just not across turns.
   */
  conversationId?: string;
  /** Manage-link JWT from the request. Verified inside the tools, never prompted. */
  accessToken?: string;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * The assistant answers in the caller's language, in salon time, and only ever touches the
 * appointment its access token names. `Toolset` in @hair-simo/ai carries no locale and no
 * session, so both are bound here when the toolset is built.
 */
export function createAiTools(input?: AppLocale | AiToolsOptions): Toolset {
  const options: AiToolsOptions = typeof input === "string" ? { locale: input } : (input ?? {});
  const locale = options.locale ?? DEFAULT_LOCALE;
  const links: ToolLinks = {
    booking: (serviceSlug) =>
      serviceSlug ? `/${locale}/booking?service=${serviceSlug}` : `/${locale}/booking`,
    services: () => `/${locale}/services`,
    manage: () => `/${locale}/manage`,
  };

  return createBookingToolset({
    backend: createBookingBackend(locale),
    session: {
      conversationId: options.conversationId ?? `anon:${randomUUID()}`,
      locale,
      channel: options.channel ?? "web",
      accessToken: options.accessToken,
    },
    links,
    salon: {
      address: `${contactInfo.address}, ${contactInfo.city}`,
      phone: contactInfo.phone,
      timeZone: SALON_TIME_ZONE,
    },
    ...(options.log ? { log: options.log } : {}),
  });
}
