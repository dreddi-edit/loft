import { notFound } from "next/navigation";
import { salonRepository } from "@hair-simo/core";
import { Badge, Card, Container, PageHeader } from "@hair-simo/ui";
import { BookingWizard } from "../../../components/BookingWizard";
import { ContactForm } from "../../../components/ContactForm";
import { resolveLocale, t } from "@hair-simo/i18n";

const pageKeys = {
  services: "services",
  prices: "prices",
  products: "products",
  team: "team",
  contact: "contact",
  booking: "booking",
  faq: "faq",
  datenschutz: "privacy",
  impressum: "imprint",
} as const;

type PageKey = keyof typeof pageKeys;

export default async function LocaleContentPage({
  params,
}: {
  params: Promise<{ locale: string; page: string }>;
}) {
  const { locale: localeInput, page } = await params;
  const locale = resolveLocale(localeInput);
  const key = pageKeys[page as PageKey];
  if (!key) notFound();

  if (page === "booking") {
    return (
      <Container>
        <BookingWizard locale={locale} />
      </Container>
    );
  }

  if (page === "contact") {
    return (
      <Container>
        <PageHeader title={t(locale, "contact_title")} subtitle={t(locale, "contact_body")} />
        <ContactForm locale={locale} />
      </Container>
    );
  }

  if (page === "services") {
    const services = await salonRepository.listServices();
    return (
      <Container>
        <PageHeader title={t(locale, "services_title")} subtitle={t(locale, "services_body")} />
        <div className="hs-grid hs-grid-3">
          {services.map((service) => {
            const translation = service.translations.find((entry) => entry.locale === locale);
            return (
              <Card key={service.id}>
                <h3>{translation?.name ?? service.slug}</h3>
                <p style={{ color: "var(--hs-muted)" }}>{translation?.description}</p>
                <Badge>{(service.priceCents / 100).toFixed(2)} EUR</Badge>
              </Card>
            );
          })}
        </div>
      </Container>
    );
  }

  if (page === "team") {
    const staff = await salonRepository.listStaff();
    return (
      <Container>
        <PageHeader title={t(locale, "team_title")} subtitle={t(locale, "team_body")} />
        <div className="hs-grid hs-grid-2">
          {staff.map((member) => (
            <Card key={member.id}>
              <h3>{member.displayName}</h3>
              <p style={{ color: "var(--hs-muted)" }}>{member.bio ?? "Senior stylist"}</p>
            </Card>
          ))}
        </div>
      </Container>
    );
  }

  return (
    <Container>
      <PageHeader title={t(locale, `${key}_title`)} subtitle={t(locale, `${key}_body`)} />
      <Card>
        <p>{t(locale, `${key}_body`)}</p>
      </Card>
    </Container>
  );
}
