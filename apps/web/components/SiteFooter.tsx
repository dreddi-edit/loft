import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Container } from "@hair-simo/ui";

export function SiteFooter({ locale }: { locale: AppLocale }) {
  return (
    <footer style={{ borderTop: "1px solid var(--hs-border)", marginTop: "3rem", padding: "1.5rem 0" }}>
      <Container>
        <div className="hs-grid hs-grid-3">
          <div>
            <strong>{t(locale, "site_title")}</strong>
            <p style={{ color: "var(--hs-muted)" }}>{t(locale, "location_value")}</p>
          </div>
          <div>
            <strong>{t(locale, "opening_hours")}</strong>
            <p style={{ color: "var(--hs-muted)" }}>{t(locale, "opening_hours_value")}</p>
          </div>
          <div>
            <a href={`/${locale}/datenschutz`}>{t(locale, "nav_privacy")}</a>
            <br />
            <a href={`/${locale}/impressum`}>{t(locale, "nav_imprint")}</a>
          </div>
        </div>
      </Container>
    </footer>
  );
}
