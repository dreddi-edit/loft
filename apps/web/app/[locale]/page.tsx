import { resolveLocale } from "@hair-simo/i18n";
import { AboutSection } from "../../components/AboutSection";
import { CTASection } from "../../components/CTASection";
import { GallerySection } from "../../components/GallerySection";
import { HeroSection } from "../../components/HeroSection";
import { HighlightsSection } from "../../components/HighlightsSection";

export default async function LocaleHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = resolveLocale((await params).locale);

  return (
    <>
      <HeroSection locale={locale} />
      <HighlightsSection locale={locale} />
      <AboutSection locale={locale} />
      <GallerySection locale={locale} />
      <CTASection locale={locale} />
    </>
  );
}
