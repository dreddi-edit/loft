import { z } from "zod";
import { chatbotSystemPrompts } from "@hair-simo/i18n";

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
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(["user", "model"]),
        text: z.string(),
      }),
    )
    .optional(),
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
  if (/book|prenot|réserv|buchen|termin/i.test(input)) return "booking_create";
  if (/price|preis|prix|prezzo|kostet|costo|co[uû]te|costs?/i.test(input)) return "price_lookup";
  if (/where|dove|adresse|standort|indirizzo|address|wo seid/i.test(input)) return "faq_location";
  if (/open|oeffnung|öffnung|orari|horaires|hours|wann habt/i.test(input)) return "faq_opening_hours";
  return "faq_opening_hours";
}

function fallbackByLocale(locale: SupportedLocale, intent: Intent) {
  if (intent === "faq_location") {
    if (locale === "de") return "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Brixen. Telefon: +39 0472 268402.";
    if (locale === "it") return "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone. Telefono: +39 0472 268402.";
    if (locale === "fr") return "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone. Telephone: +39 0472 268402.";
    return "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone. Phone: +39 0472 268402.";
  }
  if (locale === "de") return "Unsere Oeffnungszeiten: Di, Do, Fr 8:00-17:00, Mi und Sa 8:00-16:00, Montag und Sonntag geschlossen.";
  if (locale === "it") return "I nostri orari: mar, gio, ven 8:00-17:00, mer e sab 8:00-16:00, lunedi e domenica chiuso.";
  if (locale === "fr") return "Nos horaires: mar, jeu, ven 8:00-17:00, mer et sam 8:00-16:00, ferme lundi et dimanche.";
  return "Opening hours: Tue, Thu, Fri 8:00-17:00, Wed and Sat 8:00-16:00, closed Monday and Sunday.";
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  tools: Toolset,
  payload: z.infer<typeof aiRequestSchema>,
): Promise<string> {
  switch (name) {
    case "checkAvailability":
      return tools.checkAvailability(String(args.serviceId ?? payload.serviceId ?? "damen-schnitt"));
    case "createBooking":
      return tools.createBooking(
        String(args.serviceId ?? payload.serviceId ?? "damen-schnitt"),
        args.customerId ? String(args.customerId) : payload.customerId,
      );
    case "rescheduleBooking":
      return tools.rescheduleBooking(String(args.appointmentId ?? payload.appointmentId ?? "unknown"));
    case "cancelBooking":
      return tools.cancelBooking(String(args.appointmentId ?? payload.appointmentId ?? "unknown"));
    case "getServiceInfo":
      return tools.getServiceInfo(String(args.serviceId ?? payload.serviceId ?? "damen-schnitt"));
    default:
      return "I can help with bookings, prices, opening hours, and location.";
  }
}

export async function runIntentTooling(payload: z.infer<typeof aiRequestSchema>, tools: Toolset) {
  const locale = payload.locale ?? detectLocaleFromInput(payload.text);
  const intent = detectIntent(payload.text);

  switch (intent) {
    case "booking_create":
      return { locale, intent, response: await tools.createBooking(payload.serviceId ?? "damen-schnitt", payload.customerId) };
    case "booking_reschedule":
      return { locale, intent, response: await tools.rescheduleBooking(payload.appointmentId ?? "unknown") };
    case "booking_cancel":
      return { locale, intent, response: await tools.cancelBooking(payload.appointmentId ?? "unknown") };
    case "price_lookup":
      return { locale, intent, response: await tools.getServiceInfo(payload.serviceId ?? "damen-schnitt") };
    case "faq_location":
      return { locale, intent, response: fallbackByLocale(locale, intent) };
    default:
      return { locale, intent, response: fallbackByLocale(locale, intent) };
  }
}

export async function runAssistant(payload: z.infer<typeof aiRequestSchema>, tools: Toolset) {
  const locale = payload.locale ?? detectLocaleFromInput(payload.text);

  try {
    const { isGcpConfigured } = await import("@hair-simo/gcp/config");
    if (!isGcpConfigured()) {
      return { ...(await runIntentTooling(payload, tools)), provider: "regex-fallback" as const };
    }

    const { runGeminiAssistant, synthesizeGeminiResponse } = await import("@hair-simo/gcp/vertex-ai");
    const systemPrompt = chatbotSystemPrompts[locale] ?? chatbotSystemPrompts.en;
    const gemini = await runGeminiAssistant({
      text: payload.text,
      locale,
      systemPrompt,
      conversationHistory: payload.conversationHistory,
    });

    if (gemini.toolCalls.length === 0) {
      return {
        locale: gemini.locale,
        intent: gemini.intent,
        response: gemini.text || (await runIntentTooling(payload, tools)).response,
        provider: "vertex-ai-gemini" as const,
      };
    }

    const toolResults: Array<{ name: string; result: string }> = [];
    for (const call of gemini.toolCalls) {
      const result = await executeToolCall(call.name, call.args, tools, payload);
      toolResults.push({ name: call.name, result });
    }

    const response = await synthesizeGeminiResponse({
      text: payload.text,
      locale: gemini.locale,
      systemPrompt,
      toolResults,
    });

    return {
      locale: gemini.locale,
      intent: gemini.toolCalls[0]?.name ?? gemini.intent,
      response,
      provider: "vertex-ai-gemini" as const,
    };
  } catch (error) {
    console.error("runAssistant.vertex_failed", error instanceof Error ? error.message : error);
    return { ...(await runIntentTooling(payload, tools)), provider: "regex-fallback" as const };
  }
}

export { chatbotSystemPrompts, reminderTemplates, voiceGreetings } from "./templates";
