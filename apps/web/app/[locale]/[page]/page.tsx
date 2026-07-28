import { notFound } from "next/navigation";
import { resolveLocale } from "@hair-simo/i18n";

const CONTENT: Record<string, { title: string; body: string }> = {
  services: { title: "Leistungen", body: "Haarschnitt, Coloration, Styling, Pflege." },
  prices: { title: "Preise", body: "Transparente Preise in EUR inkl. Deposit-Option." },
  products: { title: "Produkte", body: "Salon-Produkte und Pflege für zuhause." },
  team: { title: "Team", body: "Erfahrene Stylisten mit Spezialisierungen." },
  contact: { title: "Kontakt", body: "Bahnhofstrasse 12, 8001 Zurich, +41 44 000 00 00." },
  booking: { title: "Online Buchen", body: "Wähle Service, Stylist und Termin in wenigen Schritten." },
  faq: { title: "FAQ", body: "Öffnungszeiten, Preise, Umbuchung und Storno." },
  datenschutz: { title: "Datenschutz", body: "DSGVO-konforme Datenverarbeitung und Rechte." },
  impressum: { title: "Impressum", body: "Rechtliche Informationen des Salons." },
};

export default async function GenericPage({
  params,
}: {
  params: Promise<{ locale: string; page: string }>;
}) {
  const { locale: localeInput, page } = await params;
  const locale = resolveLocale(localeInput);
  const content = CONTENT[page];
  if (!content) notFound();

  if (page === "booking") {
    return (
      <main>
        <h2>{content.title}</h2>
        <p>{content.body}</p>
        <form action={`/api/booking`} method="post">
          <input name="serviceSlug" defaultValue="haircut-women" />
          <input name="customerEmail" defaultValue="maria@example.com" />
          <input name="startsAt" defaultValue="2026-08-01T09:00:00.000Z" />
          <input name="locale" defaultValue={locale} />
          <button type="submit">Create booking</button>
        </form>
      </main>
    );
  }

  return (
    <main>
      <h2>{content.title}</h2>
      <p>{content.body}</p>
    </main>
  );
}
