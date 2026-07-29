import { cookies } from "next/headers";
import { DEFAULT_LOCALE, type AppLocale } from "@hair-simo/i18n";
import { isAdminLocale } from "./admin-messages";

export async function getAdminLocale(): Promise<AppLocale> {
  const value = (await cookies()).get("admin_locale")?.value ?? DEFAULT_LOCALE;
  if (isAdminLocale(value)) return value;
  return DEFAULT_LOCALE;
}
