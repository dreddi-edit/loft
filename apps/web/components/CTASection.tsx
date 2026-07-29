import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { AnchorButton, Container } from "@hair-simo/ui";

export function CTASection({ locale }: { locale: AppLocale }) {
  return (
    <section className="hs-section-tight">
      <Container>
        <div className="hs-cta-editorial">
          <div className="hs-cta-copy">
            <span className="hs-eyebrow">{t(locale, "cta_title")}</span>
            <h2>{t(locale, "cta_title")}</h2>
            <p>{t(locale, "cta_body")}</p>
          </div>
          <div className="hs-cta-actions">
            <AnchorButton href={`/${locale}/booking`}>{t(locale, "book_now")}</AnchorButton>
          </div>
        </div>
      </Container>
    </section>
  );
}
