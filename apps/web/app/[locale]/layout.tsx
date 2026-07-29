import type { ReactNode } from "react";
import { resolveLocale } from "@hair-simo/i18n";
import { ChatWidget } from "../../components/ChatWidget";
import { CookieBanner } from "../../components/CookieBanner";
import { SiteFooter } from "../../components/SiteFooter";
import { SiteHeader } from "../../components/SiteHeader";

type LocaleLayoutProps = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const locale = resolveLocale((await params).locale);
  return (
    <>
      <SiteHeader locale={locale} />
      <main>{children}</main>
      <SiteFooter locale={locale} />
      <ChatWidget locale={locale} />
      <CookieBanner locale={locale} />
    </>
  );
}

export function generateStaticParams() {
  return ["de", "it", "fr", "en"].map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const locale = resolveLocale((await params).locale);
  return {
    title: `Hair Simo - ${locale.toUpperCase()}`,
    icons: {
      icon: "/favicon.ico",
      apple: "/brand/logo-md.png",
    },
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
