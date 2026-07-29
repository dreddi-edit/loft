import { NextRequest, NextResponse } from "next/server";
import { aiRequestSchema, runAssistant } from "@hair-simo/ai";
import { salonRepository } from "@hair-simo/core";
import { aiTools } from "../../../../lib/ai-tools";
import { checkRateLimit } from "../../../../lib/rate-limit";
import { davinesProducts } from "../../../../lib/site-content";

type ChatAction = {
  label: string;
  href?: string;
  prompt?: string;
};

const localized: Record<string, Record<string, string>> = {
  de: {
    allProducts: "Alle Produkte",
    bookNow: "Jetzt buchen",
    showSlots: "Freie Termine",
    contact: "Kontakt",
    startBooking: "Buchung starten",
    products: "Produkte",
    services: "Leistungen",
    servicesIntro: "Hier sind unsere beliebtesten Leistungen:",
    askService: "Wenn du willst, nenne ich dir passende Optionen fuer deine Haarlaenge und dein Ziel.",
    showPrices: "Preise anzeigen",
  },
  it: {
    allProducts: "Tutti i prodotti",
    bookNow: "Prenota ora",
    showSlots: "Slot disponibili",
    contact: "Contatto",
    startBooking: "Inizia prenotazione",
    products: "Prodotti",
    services: "Servizi",
    servicesIntro: "Ecco i nostri servizi piu richiesti:",
    askService: "Se vuoi, ti consiglio opzioni in base a lunghezza capelli e risultato desiderato.",
    showPrices: "Vedi prezzi",
  },
  fr: {
    allProducts: "Tous les produits",
    bookNow: "Reserver",
    showSlots: "Creneaux libres",
    contact: "Contact",
    startBooking: "Demarrer reservation",
    products: "Produits",
    services: "Services",
    servicesIntro: "Voici nos prestations les plus demandees :",
    askService: "Si vous voulez, je peux proposer les meilleures options selon votre longueur et objectif.",
    showPrices: "Voir tarifs",
  },
  en: {
    allProducts: "All products",
    bookNow: "Book now",
    showSlots: "Free slots",
    contact: "Contact",
    startBooking: "Start booking",
    products: "Products",
    services: "Services",
    servicesIntro: "Here are our most requested services:",
    askService: "If you want, I can suggest the best option for your hair length and result.",
    showPrices: "Show prices",
  },
};

function L(locale: string) {
  return localized[locale] ?? localized.de;
}

function detectServiceSlug(text: string) {
  const value = text.toLowerCase();
  if (/balayage|str[aä]hn|highlight/.test(value)) return "balayage-straehnen";
  if (/damen|frau|women/.test(value)) return "damen-schnitt";
  if (/herren|mann|men/.test(value)) return "herren-schnitt";
  if (/kinder|kind|child/.test(value)) return "kinder-schnitt";
  if (/behandlung|treatment|keratin/.test(value)) return "behandlung";
  return "";
}

function buildProductActions(locale: string, text: string): ChatAction[] {
  const value = text.toLowerCase();
  if (!/produkt|product|davines|pflege|shampoo|maske|oil|creme/.test(value)) return [];
  const base = `/${locale}/products`;
  const picks = davinesProducts.slice(0, 4);
  return [
    { label: L(locale).allProducts, href: base },
    ...picks.map((product) => ({ label: product.name, href: `${base}#${product.slug}` })),
  ];
}

function buildBookingActions(locale: string, text: string): ChatAction[] {
  const value = text.toLowerCase();
  if (!/buch|book|prenot|reserv|termin|slot|frei/.test(value)) return [];
  const service = detectServiceSlug(value);
  const bookingHref = service ? `/${locale}/booking?service=${service}` : `/${locale}/booking`;
  return [
    { label: L(locale).bookNow, href: bookingHref },
    { label: L(locale).showSlots, prompt: "Zeig mir freie Termine diese Woche." },
    { label: L(locale).contact, href: `/${locale}/contact` },
  ];
}

function buildDefaultActions(locale: string): ChatAction[] {
  return [
    { label: L(locale).startBooking, href: `/${locale}/booking` },
    { label: L(locale).products, href: `/${locale}/products` },
    { label: L(locale).services, href: `/${locale}/services` },
  ];
}

async function buildServiceSuggestion(locale: string) {
  const services = await salonRepository.listServices();
  const top = services.slice(0, 5);
  const names = top.map((service) => {
    const translated = service.translations.find((entry) => entry.locale === locale)?.name;
    return translated ?? service.translations.find((entry) => entry.locale === "de")?.name ?? service.slug;
  });
  return `${L(locale).servicesIntro}\n- ${names.join("\n- ")}\n\n${L(locale).askService}`;
}

export async function POST(request: NextRequest) {
  const client = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`chat-web:${client}`)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const payload = aiRequestSchema.parse(await request.json());
    const result = await runAssistant(payload, aiTools);
    const locale = payload.locale ?? result.locale;
    const serviceQuestion = /leistung|service|services|angebot|menu|prestation|servizi|servizio/i.test(payload.text.toLowerCase());
    const responseText = serviceQuestion ? await buildServiceSuggestion(locale) : result.response;
    const actions = [
      ...buildBookingActions(locale, payload.text),
      ...buildProductActions(locale, payload.text),
    ];
    if (serviceQuestion) actions.unshift({ label: L(locale).showPrices, href: `/${locale}/services` });
    const fallbackActions = actions.length > 0 ? actions : buildDefaultActions(locale);

    await salonRepository.upsertConversationMessage({
      channel: "web",
      locale: payload.locale ?? result.locale,
      customerId: payload.customerId,
      role: "user",
      content: payload.text,
      externalRef: payload.customerId ? `web:${payload.customerId}` : `web:${client}`,
    });
    await salonRepository.upsertConversationMessage({
      channel: "web",
      locale: result.locale,
      customerId: payload.customerId,
      role: "assistant",
      content: responseText,
      externalRef: payload.customerId ? `web:${payload.customerId}` : `web:${client}`,
    });

    return NextResponse.json({ data: { ...result, response: responseText, actions: fallbackActions } });
  } catch (error) {
    return NextResponse.json(
      { error: "CHAT_REQUEST_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
