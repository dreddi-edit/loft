import { resolveLocale } from "@hair-simo/i18n";

export default async function LocaleHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = resolveLocale((await params).locale);
  return (
    <main>
      <h2>Hair Simo ({locale})</h2>
      <p>Premium salon experiences with multilingual booking and AI assistants.</p>
    </main>
  );
}
