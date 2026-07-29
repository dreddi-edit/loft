import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { AnchorButton, Container } from "@hair-simo/ui";
import { davinesProducts } from "../lib/site-content";

export function ProductsSection({ locale }: { locale: AppLocale }) {
  const featured = davinesProducts.slice(0, 4);

  return (
    <section className="hs-section-tight">
      <Container>
        <div style={{ display: "grid", gap: "1.5rem" }}>
          <div>
            <span className="hs-eyebrow">{t(locale, "products_brand")}</span>
            <h2 className="hs-display" style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", margin: "0 0 1rem" }}>
              {t(locale, "products_title")}
            </h2>
            <p style={{ color: "var(--hs-muted)", margin: 0 }}>{t(locale, "products_body")}</p>
          </div>
          <div className="hs-product-grid hs-product-grid-home">
            {featured.map((product) => (
              <article key={product.slug} id={product.slug} className="hs-card hs-product-card">
                <div className="hs-product-image-wrap">
                  <img src={product.image} alt={product.name} className="hs-product-image" loading="lazy" />
                </div>
                <h3>{product.name}</h3>
                <p>{product.description[locale]}</p>
              </article>
            ))}
          </div>
          <div>
            <AnchorButton href={`/${locale}/products`} variant="secondary">
              {t(locale, "nav_products")}
            </AnchorButton>
          </div>
        </div>
      </Container>
    </section>
  );
}
