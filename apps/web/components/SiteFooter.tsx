import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { BrandLogo, Container } from "@hair-simo/ui";
import { contactInfo } from "../lib/site-content";

export function SiteFooter({ locale }: { locale: AppLocale }) {
  return (
    <footer className="hs-site-footer">
      <Container>
        <div className="hs-footer-grid">
          <div>
            <BrandLogo href={`/${locale}`} alt={t(locale, "site_title")} size="md" invert />
            <p style={{ color: "#d9d0c5", margin: "0 0 0.5rem" }}>{t(locale, "location_value")}</p>
            <p style={{ margin: "0.25rem 0" }}>
              <a href={contactInfo.phoneHref}>{t(locale, "phone_value")}</a>
            </p>
            <p style={{ margin: "0.25rem 0" }}>
              <a href={contactInfo.emailHref}>{t(locale, "email_value")}</a>
            </p>
          </div>

          <div>
            <div className="hs-footer-title">{t(locale, "opening_hours")}</div>
            <div className="hs-hours-row">
              <span>{t(locale, "hours_mon")}</span>
              <span>{t(locale, "hours_closed")}</span>
            </div>
            <div className="hs-hours-row">
              <span>{t(locale, "hours_tue_fri")}</span>
              <span>{t(locale, "hours_open_tue_fri")}</span>
            </div>
            <div className="hs-hours-row">
              <span>{t(locale, "hours_wed_sat")}</span>
              <span>{t(locale, "hours_open_wed_sat")}</span>
            </div>
            <div className="hs-hours-row">
              <span>{t(locale, "hours_sun")}</span>
              <span>{t(locale, "hours_closed")}</span>
            </div>
          </div>

          <div>
            <div className="hs-footer-title">{t(locale, "nav_booking")}</div>
            <p style={{ margin: "0 0 1rem", color: "#d9d0c5" }}>{t(locale, "cta_body")}</p>
            <p style={{ margin: 0 }}>
              <a href={`/${locale}/booking`}>{t(locale, "book_now")}</a>
            </p>
            <p style={{ margin: "0.75rem 0 0" }}>
              <a href={`/${locale}/datenschutz`}>{t(locale, "nav_privacy")}</a>
            </p>
            <p style={{ margin: "0.35rem 0 0" }}>
              <a href={`/${locale}/impressum`}>{t(locale, "nav_imprint")}</a>
            </p>
          </div>
        </div>
      </Container>
    </footer>
  );
}
