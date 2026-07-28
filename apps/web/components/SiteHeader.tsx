import type { AppLocale } from "@hair-simo/i18n";
import { SUPPORTED_LOCALES, t } from "@hair-simo/i18n";
import { AnchorButton, Container } from "@hair-simo/ui";

const navItems = [
  "nav_home",
  "nav_services",
  "nav_prices",
  "nav_products",
  "nav_team",
  "nav_contact",
  "nav_booking",
  "nav_faq",
] as const;

const navPaths: Record<(typeof navItems)[number], string> = {
  nav_home: "",
  nav_services: "services",
  nav_prices: "prices",
  nav_products: "products",
  nav_team: "team",
  nav_contact: "contact",
  nav_booking: "booking",
  nav_faq: "faq",
};

export function SiteHeader({ locale }: { locale: AppLocale }) {
  return (
    <header style={{ borderBottom: "1px solid var(--hs-border)", padding: "1rem 0", marginBottom: "2rem" }}>
      <Container>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <strong style={{ fontSize: "1.25rem" }}>{t(locale, "site_title")}</strong>
            <div style={{ color: "var(--hs-muted)", fontSize: "0.875rem" }}>{t(locale, "site_tagline")}</div>
          </div>
          <nav style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", fontSize: "0.9rem" }}>
            {navItems.map((key) => (
              <a key={key} href={`/${locale}/${navPaths[key]}`.replace(/\/$/, "") || `/${locale}`}>
                {t(locale, key)}
              </a>
            ))}
          </nav>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {SUPPORTED_LOCALES.map((entry) => (
              <a key={entry} href={`/${entry}`} style={{ opacity: entry === locale ? 1 : 0.6 }}>
                {entry.toUpperCase()}
              </a>
            ))}
            <AnchorButton href={`/${locale}/booking`}>{t(locale, "book_now")}</AnchorButton>
          </div>
        </div>
      </Container>
    </header>
  );
}
