import type { ReactNode } from "react";
import { resolveLocale } from "@hair-simo/i18n";
import { ChatWidget } from "../../components/ChatWidget";
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
      <main style={{ minHeight: "60vh" }}>{children}</main>
      <SiteFooter locale={locale} />
      <ChatWidget locale={locale} />
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
