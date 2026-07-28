import { z } from "zod";

export type SupportedLocale = "de" | "it" | "fr" | "en";
export type Intent =
  | "faq_opening_hours"
  | "faq_location"
  | "price_lookup"
  | "booking_create"
  | "booking_reschedule"
  | "booking_cancel";

export const aiRequestSchema = z.object({
  text: z.string().min(1),
  locale: z.enum(["de", "it", "fr", "en"]).optional(),
  customerId: z.string().optional(),
  serviceId: z.string().optional(),
  appointmentId: z.string().optional(),
});

export type Toolset = {
  checkAvailability: (serviceId: string) => Promise<string>;
  createBooking: (serviceId: string, customerId?: string) => Promise<string>;
  rescheduleBooking: (appointmentId: string) => Promise<string>;
  cancelBooking: (appointmentId: string) => Promise<string>;
  getServiceInfo: (serviceId: string) => Promise<string>;
};

export function detectLocaleFromInput(input: string): SupportedLocale {
  if (/ciao|buongiorno|prenot/i.test(input)) return "it";
  if (/bonjour|salut|réserver/i.test(input)) return "fr";
  if (/hallo|guten tag|buchen/i.test(input)) return "de";
  return "en";
}

export function detectIntent(input: string): Intent {
  if (/storno|cancel|annuler|cancellare/i.test(input)) return "booking_cancel";
  if (/umbuch|resched|déplacer|spostare/i.test(input)) return "booking_reschedule";
  if (/book|prenot|réserv|buchen/i.test(input)) return "booking_create";
  if (/price|preis|prix|prezzo/i.test(input)) return "price_lookup";
  if (/where|dove|adresse|adresse|standort/i.test(input)) return "faq_location";
  return "faq_opening_hours";
}

export async function runIntentTooling(payload: z.infer<typeof aiRequestSchema>, tools: Toolset) {
  const locale = payload.locale ?? detectLocaleFromInput(payload.text);
  const intent = detectIntent(payload.text);

  switch (intent) {
    case "booking_create":
      return { locale, intent, response: await tools.createBooking(payload.serviceId ?? "haircut-women", payload.customerId) };
    case "booking_reschedule":
      return { locale, intent, response: await tools.rescheduleBooking(payload.appointmentId ?? "unknown") };
    case "booking_cancel":
      return { locale, intent, response: await tools.cancelBooking(payload.appointmentId ?? "unknown") };
    case "price_lookup":
      return { locale, intent, response: await tools.getServiceInfo(payload.serviceId ?? "haircut-women") };
    case "faq_location":
      return {
        locale,
        intent,
        response: "Hair Simo, Bahnhofstrasse 12, 8001 Zurich. +41 44 000 00 00.",
      };
    default:
      return {
        locale,
        intent,
        response: "Mon-Fri 09:00-20:00, Sat 08:00-16:00, Sunday closed.",
      };
  }
}

export { chatbotSystemPrompts, reminderTemplates, voiceGreetings } from "./templates";
