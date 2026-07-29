import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { AnchorButton, Container } from "@hair-simo/ui";
import { contactInfo, siteImages } from "../lib/site-content";

export function HeroSection({ locale }: { locale: AppLocale }) {
  return (
    <section className="hs-hero">
      <video className="hs-hero-video" autoPlay muted loop playsInline>
        <source src={siteImages.heroVideo} type="video/mp4" />
      </video>
      <div className="hs-hero-bg" style={{ backgroundImage: `url(${siteImages.hero})` }} />
      <div className="hs-hero-overlay" />
      <Container>
        <div className="hs-hero-content">
          <span className="hs-eyebrow" style={{ color: "rgba(255,255,255,0.85)" }}>
            {t(locale, "hero_eyebrow")}
          </span>
          <h1 className="hs-hero-title">{t(locale, "hero_title")}</h1>
          <p className="hs-hero-subtitle">{t(locale, "hero_subtitle")}</p>
          <div className="hs-hero-actions">
            <AnchorButton href={`/${locale}/booking`}>{t(locale, "hero_cta")}</AnchorButton>
            <a href={contactInfo.phoneHref} className="hs-btn hs-btn-ghost">
              {t(locale, "call_now")}
            </a>
          </div>
        </div>
      </Container>
    </section>
  );
}
