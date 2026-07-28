import type { ReactNode } from "react";
import { resolveLocale, t, type AppLocale } from "@hair-simo/i18n";

type LocaleLayoutProps = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const locale = resolveLocale((await params).locale);
  return (
    <div>
      <header>
        <h1>{t(locale, "site_title")}</h1>
        <nav>
          <a href={`/${locale}`}>Home</a> | <a href={`/${locale}/services`}>Leistungen</a> |{" "}
          <a href={`/${locale}/prices`}>Preise</a> | <a href={`/${locale}/booking`}>{t(locale, "book_now")}</a>
        </nav>
      </header>
      {children}
      <footer>
        <small>{t(locale, "opening_hours")}: Mon-Fri 09:00-20:00</small>
      </footer>
    </div>
  );
}

export function generateStaticParams() {
  return ["de", "it", "fr", "en"].map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: AppLocale } }) {
  return {
    title: `Hair Simo - ${params.locale.toUpperCase()}`,
    alternates: {
      languages: {
        de: "/de",
        it: "/it",
        fr: "/fr",
        en: "/en",
      },
    },
  };
}
