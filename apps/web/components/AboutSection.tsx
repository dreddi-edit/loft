import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Container } from "@hair-simo/ui";
import { siteImages } from "../lib/site-content";

export function AboutSection({ locale }: { locale: AppLocale }) {
  return (
    <section className="hs-section">
      <Container>
        <div className="hs-split">
          <div className="hs-about-image">
            <img src={siteImages.about} alt={t(locale, "about_title")} />
          </div>
          <div>
            <span className="hs-eyebrow">{t(locale, "location_short")}</span>
            <h2 className="hs-display" style={{ fontSize: "clamp(2rem, 4vw, 3rem)", margin: "0 0 1rem" }}>
              {t(locale, "about_title")}
            </h2>
            <p style={{ color: "var(--hs-muted)", margin: "0 0 1rem" }}>{t(locale, "about_body")}</p>
            <p style={{ color: "var(--hs-muted)", margin: 0 }}>{t(locale, "about_body_2")}</p>
          </div>
        </div>
      </Container>
    </section>
  );
}
