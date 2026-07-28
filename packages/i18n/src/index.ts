export const SUPPORTED_LOCALES = ["de", "it", "fr", "en"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

export const dictionaries: Record<AppLocale, Record<string, string>> = {
  de: {
    site_title: "Hair Simo",
    book_now: "Jetzt buchen",
    opening_hours: "Öffnungszeiten",
    location: "Standort",
  },
  it: {
    site_title: "Hair Simo",
    book_now: "Prenota ora",
    opening_hours: "Orari di apertura",
    location: "Posizione",
  },
  fr: {
    site_title: "Hair Simo",
    book_now: "Réserver maintenant",
    opening_hours: "Heures d'ouverture",
    location: "Adresse",
  },
  en: {
    site_title: "Hair Simo",
    book_now: "Book now",
    opening_hours: "Opening hours",
    location: "Location",
  },
};

export function isLocale(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value?: string): AppLocale {
  if (value && isLocale(value)) return value;
  return DEFAULT_LOCALE;
}

export function t(locale: AppLocale, key: string): string {
  return dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
}
