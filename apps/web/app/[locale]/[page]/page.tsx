import { notFound } from "next/navigation";
import { salonRepository } from "@hair-simo/core";
import { Card, Container } from "@hair-simo/ui";
import { BookingWizard } from "../../../components/BookingWizard";
import { ContactForm } from "../../../components/ContactForm";
import { CTASection } from "../../../components/CTASection";
import { PageHero } from "../../../components/PageHero";
import { contactInfo, siteImages, davinesProducts } from "../../../lib/site-content";
import { legalContent } from "../../../lib/legal-content";
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
      <>
        <PageHero locale={locale} titleKey="booking_title" bodyKey="cta_body" />
        <Container style={{ paddingBottom: "4rem" }}>
          <BookingWizard locale={locale} />
        </Container>
      </>
    );
  }

  if (page === "contact") {
    return (
      <>
        <section className="hs-contact-hero">
          <Container>
            <span className="hs-eyebrow">{t(locale, "site_tagline")}</span>
            <h1>{t(locale, "contact_title")}</h1>
            <p>{t(locale, "contact_body")}</p>
          </Container>
        </section>
        <Container style={{ paddingBottom: "6rem" }}>
          <div className="hs-contact-editorial">
            <div className="hs-contact-info">
              <div className="hs-contact-section-heading">
                <span>01</span>
                <h2>{t(locale, "location")}</h2>
              </div>
              <a className="hs-contact-primary-link" href={contactInfo.phoneHref}>{t(locale, "phone_value")}</a>
              <a className="hs-contact-primary-link" href={contactInfo.emailHref}>{t(locale, "email_value")}</a>
              <div className="hs-contact-address-block">
                <p>{contactInfo.address}</p>
                <p>{contactInfo.city}</p>
              </div>
              <a
                className="hs-contact-map-link"
                href="https://maps.google.com/?q=Via+Bastioni+Maggiori+4%2Fc+Bressanone"
                target="_blank"
                rel="noreferrer"
              >
                Google Maps <span aria-hidden="true">↗</span>
              </a>
            </div>
            <ContactForm locale={locale} />
          </div>
        </Container>
      </>
    );
  }

  if (page === "services") {
    const services = await salonRepository.listServices();
    return (
      <>
        <section className="hs-services-hero">
          <Container>
            <span className="hs-eyebrow">{t(locale, "site_tagline")}</span>
            <h1>{t(locale, "services_title")}</h1>
            <p>{t(locale, "services_body")}</p>
          </Container>
        </section>
        <Container style={{ paddingBottom: "6rem" }}>
          <div className="hs-services-list">
            {services.map((service) => {
              const translation = service.translations.find((entry) => entry.locale === locale);
              return (
                <article key={service.id} className="hs-service-row">
                  <span className="hs-service-index">
                    {String(services.indexOf(service) + 1).padStart(2, "0")}
                  </span>
                  <div className="hs-service-copy">
                    <h2>{translation?.name ?? service.slug}</h2>
                    <p>{translation?.description}</p>
                  </div>
                  <div className="hs-service-meta">
                    <span>{service.durationMin} min</span>
                    <strong>{(service.priceCents / 100).toFixed(0)} €</strong>
                  </div>
                  <a href={`/${locale}/booking?service=${service.slug}`} className="hs-service-book">
                    {t(locale, "book_now")} <span aria-hidden="true">↗</span>
                  </a>
                </article>
              );
            })}
          </div>
        </Container>
      </>
    );
  }

  if (page === "team") {
    const staff = await salonRepository.listStaff();
    return (
      <>
        <section className="hs-team-hero">
          <Container>
            <span className="hs-eyebrow">{t(locale, "site_tagline")}</span>
            <h1>{t(locale, "team_title")}</h1>
            <p>{t(locale, "team_body")}</p>
          </Container>
        </section>
        <Container style={{ paddingBottom: "6rem" }}>
          <div className="hs-team-editorial">
            {staff.map((member, index) => (
              <article key={member.id} className={`hs-team-editorial-item ${index % 2 ? "reverse" : ""}`}>
                <div className="hs-team-editorial-image">
                  <img src={siteImages.gallery[index % siteImages.gallery.length]} alt={member.displayName} />
                </div>
                <div className="hs-team-editorial-copy">
                  <span className="hs-team-number">{String(index + 1).padStart(2, "0")}</span>
                  <p className="hs-eyebrow">{t(locale, "team_role")}</p>
                  <h3>{member.displayName}</h3>
                  <p>{member.bio ?? t(locale, "team_body")}</p>
                </div>
              </article>
            ))}
          </div>
        </Container>
      </>
    );
  }

  if (page === "products") {
    return (
      <>
        <PageHero locale={locale} titleKey="products_title" bodyKey="products_body" />
        <Container style={{ paddingBottom: "4rem" }}>
          <div className="hs-products-editorial">
            <p className="hs-products-intro">{t(locale, "products_body")}</p>
            <div className="hs-products-list">
              {davinesProducts.map((product, index) => (
                <article key={product.slug} id={product.slug} className={`hs-product-editorial-row ${index % 2 ? "reverse" : ""}`}>
                  <div className="hs-product-editorial-image-wrap">
                    <img src={product.image} alt={product.name} className="hs-product-editorial-image" loading="lazy" />
                  </div>
                  <div className="hs-product-editorial-copy">
                    <p className="hs-eyebrow">Davines SU</p>
                    <h3>{product.name}</h3>
                    <p>{product.description[locale]}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </Container>
        <CTASection locale={locale} />
      </>
    );
  }

  if (page === "datenschutz" || page === "impressum") {
    const sections = page === "datenschutz" ? legalContent[locale].privacy : legalContent[locale].imprint;
    return (
      <>
        <PageHero locale={locale} titleKey={`${key}_title`} bodyKey={`${key}_body`} />
        <Container style={{ paddingBottom: "4rem" }}>
          <Card>
            <div style={{ display: "grid", gap: "1.25rem" }}>
              {sections.map((section) => (
                <section key={section.heading}>
                  <h2 className="hs-display" style={{ fontSize: "1.5rem", margin: "0 0 0.6rem" }}>
                    {section.heading}
                  </h2>
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph} style={{ margin: "0.45rem 0", color: "var(--hs-muted)" }}>
                      {paragraph}
                    </p>
                  ))}
                </section>
              ))}
            </div>
          </Card>
        </Container>
      </>
    );
  }

  return (
    <>
      <PageHero locale={locale} titleKey={`${key}_title`} bodyKey={`${key}_body`} />
      <Container style={{ paddingBottom: "4rem" }}>
        <Card>
          <p style={{ margin: 0, color: "var(--hs-muted)" }}>{t(locale, `${key}_body`)}</p>
        </Card>
      </Container>
      {page !== "datenschutz" && page !== "impressum" ? <CTASection locale={locale} /> : null}
    </>
  );
}
