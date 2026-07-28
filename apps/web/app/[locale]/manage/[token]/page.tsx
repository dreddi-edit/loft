import { resolveLocale } from "@hair-simo/i18n";
import { Container } from "@hair-simo/ui";
import { ManageAppointment } from "../../../../components/ManageAppointment";

export default async function ManageAppointmentPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: localeInput, token } = await params;
  const locale = resolveLocale(localeInput);
  return (
    <Container>
      <ManageAppointment locale={locale} token={token} />
    </Container>
  );
}
