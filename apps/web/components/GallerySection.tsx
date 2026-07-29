import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Container } from "@hair-simo/ui";
import { siteImages } from "../lib/site-content";

export function GallerySection({ locale }: { locale: AppLocale }) {
  const [main, ...rest] = siteImages.gallery;
  return (
    <section className="hs-section">
      <Container>
        <div className="hs-gallery-header">
          <span className="hs-eyebrow">{t(locale, "gallery_title")}</span>
          <h2 className="hs-display hs-gallery-title">
            {t(locale, "gallery_title")}
          </h2>
          <p className="hs-gallery-copy">{t(locale, "gallery_body")}</p>
        </div>

        <div className="hs-gallery-editorial">
          <article className="hs-gallery-main">
            <img src={main} alt={`${t(locale, "site_title")} main`} loading="lazy" />
          </article>
          <div className="hs-gallery-rail">
            {rest.map((src, index) => (
              <article key={src} className={`hs-gallery-rail-item ${index === 1 ? "feature" : ""}`}>
                <img src={src} alt={`${t(locale, "site_title")} ${index + 2}`} loading="lazy" />
              </article>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
