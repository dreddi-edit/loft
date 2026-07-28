export type SupportedLocale = "de" | "it" | "fr" | "en";

export function detectLocaleFromInput(input: string): SupportedLocale {
  if (/ciao|buongiorno/i.test(input)) return "it";
  if (/bonjour|salut/i.test(input)) return "fr";
  if (/hallo|guten tag/i.test(input)) return "de";
  return "en";
}
