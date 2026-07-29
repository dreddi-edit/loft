import { dictionaries } from "./dictionaries";

export const SUPPORTED_LOCALES = ["de", "it", "fr", "en"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "de";

export { dictionaries };

export function isLocale(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value?: string | null): AppLocale {
  if (value && isLocale(value)) return value;
  return DEFAULT_LOCALE;
}

export function t(locale: AppLocale, key: keyof (typeof dictionaries)[AppLocale] | string): string {
  const value = dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key];
  return typeof value === "string" ? value : key;
}

export function getServiceTranslationName(
  translations: { locale: string; name: string }[],
  locale: AppLocale,
  fallback = "Service",
): string {
  return translations.find((entry) => entry.locale === locale)?.name ?? fallback;
}

export { chatbotSystemPrompts, reminderTemplates, voiceGreetings } from "./templates";
