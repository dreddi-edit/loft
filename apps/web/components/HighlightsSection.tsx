import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Container } from "@hair-simo/ui";

const highlights = ["highlight_1", "highlight_2", "highlight_3"] as const;

export function HighlightsSection({ locale }: { locale: AppLocale }) {
  return (
    <section className="hs-section-tight" style={{ background: "var(--hs-surface-elevated)" }}>
      <Container>
        <div className="hs-highlight-grid">
          {highlights.map((key) => (
            <article key={key} className="hs-highlight-card hs-card-hover">
              <h3>{t(locale, `${key}_title`)}</h3>
              <p style={{ color: "var(--hs-muted)", margin: 0 }}>{t(locale, `${key}_body`)}</p>
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}
