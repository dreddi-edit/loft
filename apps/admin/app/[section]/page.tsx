import { notFound } from "next/navigation";

const sections: Record<string, { title: string; description: string }> = {
  dashboard: { title: "Dashboard", description: "KPIs: Umsatz, Auslastung, Termine heute." },
  calendar: { title: "Kalender", description: "Ressourcen- und Terminübersicht." },
  appointments: { title: "Termine", description: "Verwalten, umbuchen, stornieren." },
  customers: { title: "Kunden", description: "CRM-Ansicht mit Historie und Notizen." },
  services: { title: "Services", description: "Leistungen, Dauer, Preise, Übersetzungen." },
  staff: { title: "Mitarbeiter", description: "Skills, Verfügbarkeiten und Abwesenheiten." },
  rules: { title: "Öffnungszeiten/Regeln", description: "Business hours und Buchungsregeln." },
  reports: { title: "Reports", description: "Basisberichte zu Umsatz und No-Show-Rate." },
};

export default async function AdminSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const section = (await params).section;
  const content = sections[section];
  if (!content) notFound();

  return (
    <main>
      <h1>{content.title}</h1>
      <p>{content.description}</p>
    </main>
  );
}
