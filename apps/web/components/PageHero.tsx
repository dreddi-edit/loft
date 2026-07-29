import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Container } from "@hair-simo/ui";

export function PageHero({ locale, titleKey, bodyKey }: { locale: AppLocale; titleKey: string; bodyKey: string }) {
  return (
    <section className="hs-page-hero">
      <Container>
        <span className="hs-eyebrow">{t(locale, "site_tagline")}</span>
        <h1>{t(locale, titleKey)}</h1>
        <p>{t(locale, bodyKey)}</p>
      </Container>
    </section>
  );
}
