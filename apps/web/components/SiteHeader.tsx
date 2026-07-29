import type { AppLocale } from "@hair-simo/i18n";
import { SUPPORTED_LOCALES, t } from "@hair-simo/i18n";
import { AnchorButton, BrandLogo, Container } from "@hair-simo/ui";
import { contactInfo } from "../lib/site-content";

const navItems = [
  "nav_home",
  "nav_services",
  "nav_products",
  "nav_team",
  "nav_contact",
] as const;

const navPaths: Record<(typeof navItems)[number], string> = {
  nav_home: "",
  nav_services: "services",
  nav_products: "products",
  nav_team: "team",
  nav_contact: "contact",
};

export function SiteHeader({ locale }: { locale: AppLocale }) {
  return (
    <header className="hs-site-header">
      <Container>
        <div className="hs-header-shell">
          <div className="hs-header-logo">
            <BrandLogo href={`/${locale}`} alt={t(locale, "site_title")} />
          </div>

          <div className="hs-header-nav-wrap">
            <nav className="hs-nav" aria-label="Main">
              {navItems.map((key) => (
                <a key={key} href={`/${locale}/${navPaths[key]}`.replace(/\/$/, "") || `/${locale}`}>
                  {t(locale, key)}
                </a>
              ))}
            </nav>

            <div className="hs-site-header-actions">
              <details className="hs-locale-dropdown">
                <summary>{locale.toUpperCase()}</summary>
                <div className="hs-locale-dropdown-menu">
                  {SUPPORTED_LOCALES.map((entry) => (
                    <a key={entry} href={`/${entry}`} className={entry === locale ? "active" : undefined}>
                      {entry.toUpperCase()}
                    </a>
                  ))}
                </div>
              </details>
              <a href={contactInfo.phoneHref} className="hs-header-phone">
                {t(locale, "call_now")}
              </a>
              <AnchorButton href={`/${locale}/booking`} className="hs-header-booking">
                {t(locale, "book_now")}
              </AnchorButton>
            </div>
          </div>
        </div>
      </Container>
    </header>
  );
}
