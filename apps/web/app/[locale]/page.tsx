import { AnchorButton, Card, Container, PageHeader } from "@hair-simo/ui";
import { resolveLocale, t } from "@hair-simo/i18n";

export default async function LocaleHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = resolveLocale((await params).locale);

  return (
    <Container>
      <section style={{ padding: "2rem 0" }}>
        <PageHeader title={t(locale, "hero_title")} subtitle={t(locale, "hero_subtitle")} />
        <AnchorButton href={`/${locale}/booking`}>{t(locale, "hero_cta")}</AnchorButton>
      </section>
      <section className="hs-grid hs-grid-3">
        <Card>
          <h3>{t(locale, "nav_services")}</h3>
          <p style={{ color: "var(--hs-muted)" }}>{t(locale, "services_body")}</p>
        </Card>
        <Card>
          <h3>{t(locale, "nav_booking")}</h3>
          <p style={{ color: "var(--hs-muted)" }}>{t(locale, "booking_title")}</p>
        </Card>
        <Card>
          <h3>{t(locale, "opening_hours")}</h3>
          <p style={{ color: "var(--hs-muted)" }}>{t(locale, "opening_hours_value")}</p>
        </Card>
      </section>
    </Container>
  );
}
