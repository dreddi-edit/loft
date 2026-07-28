"use client";

import { useMemo, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Badge, Button, Card, Input, PageHeader, Select } from "@hair-simo/ui";

type Service = {
  id: string;
  slug: string;
  durationMin: number;
  priceCents: number;
  translations: { locale: string; name: string; description: string }[];
};

type Staff = { id: string; displayName: string };

type Slot = { startsAt: string; endsAt: string };

const steps = ["service", "stylist", "datetime", "details", "payment"] as const;

export function BookingWizard({ locale }: { locale: AppLocale }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [googlePayReady, setGooglePayReady] = useState(false);

  const [serviceSlug, setServiceSlug] = useState("haircut-women");
  const [staffId, setStaffId] = useState("");
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [startsAt, setStartsAt] = useState("");
  const [email, setEmail] = useState("maria@example.com");
  const [firstName, setFirstName] = useState("Maria");
  const [lastName, setLastName] = useState("Rossi");
  const [phone, setPhone] = useState("+41790000000");
  const [paymentMode, setPaymentMode] = useState<"deposit" | "full">("deposit");

  const step = steps[stepIndex];
  const selectedService = useMemo(
    () => services.find((entry) => entry.slug === serviceSlug),
    [services, serviceSlug],
  );

  async function ensureCatalogLoaded() {
    if (services.length > 0) return;
    const [servicesRes, staffRes] = await Promise.all([
      fetch("/api/services"),
      fetch("/api/staff").catch(() => null),
    ]);
    const servicesJson = await servicesRes.json();
    setServices(servicesJson.data ?? []);
    if (staffRes) {
      const staffJson = await staffRes.json();
      setStaff((staffJson.data ?? []).map((entry: { id: string; displayName: string }) => ({
        id: entry.id,
        displayName: entry.displayName,
      })));
    }
  }

  async function loadSlots() {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        serviceSlug,
        day: new Date(`${day}T09:00:00.000Z`).toISOString(),
      });
      if (staffId) query.set("staffId", staffId);
      const response = await fetch(`/api/availability?${query.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "AVAILABILITY_ERROR");
      setSlots(json.data ?? []);
      if (json.data?.[0]) setStartsAt(json.data[0].startsAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, "error_generic"));
    } finally {
      setLoading(false);
    }
  }

  async function createBooking() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceSlug,
          startsAt,
          customerEmail: email,
          customerFirstName: firstName,
          customerLastName: lastName,
          customerPhone: phone,
          locale,
          staffId: staffId || undefined,
          sourceChannel: "web",
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "BOOKING_CREATE_FAILED");
      setAppointmentId(json.data.id);
      setStepIndex(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, "error_generic"));
    } finally {
      setLoading(false);
    }
  }

  async function createGooglePayCheckout() {
    if (!appointmentId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointmentId,
          serviceSlug,
          mode: paymentMode,
          depositPercentage: 30,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "PAYMENT_CHECKOUT_FAILED");
      setPaymentId(json.data.paymentId);
      setGooglePayReady(Boolean(json.data.googlePayRequest));
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, "error_generic"));
    } finally {
      setLoading(false);
    }
  }

  async function nextStep() {
    setError(null);
    if (step === "service") {
      await ensureCatalogLoaded();
      setStepIndex(1);
      return;
    }
    if (step === "stylist") {
      setStepIndex(2);
      return;
    }
    if (step === "datetime") {
      await loadSlots();
      setStepIndex(3);
      return;
    }
    if (step === "details") {
      await createBooking();
      return;
    }
    if (step === "payment") {
      await createGooglePayCheckout();
    }
  }

  return (
    <div>
      <PageHeader title={t(locale, "booking_title")} subtitle={t(locale, "hero_subtitle")} />
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        {steps.map((entry, index) => (
          <Badge key={entry}>{index <= stepIndex ? "✓" : "•"} {t(locale, `booking_step_${entry}` as never)}</Badge>
        ))}
      </div>

      <Card>
        {step === "service" ? (
          <Select label={t(locale, "booking_step_service")} value={serviceSlug} onChange={(event) => setServiceSlug(event.target.value)}>
            {(services.length ? services : [{ slug: "haircut-women", translations: [{ locale, name: "Haircut" }] } as Service]).map(
              (service) => (
                <option key={service.slug} value={service.slug}>
                  {service.translations.find((tr) => tr.locale === locale)?.name ?? service.slug} (
                  {(service.priceCents / 100).toFixed(2)} EUR)
                </option>
              ),
            )}
          </Select>
        ) : null}

        {step === "stylist" ? (
          <Select label={t(locale, "booking_step_stylist")} value={staffId} onChange={(event) => setStaffId(event.target.value)}>
            <option value="">{t(locale, "booking_any_stylist")}</option>
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </Select>
        ) : null}

        {step === "datetime" ? (
          <div className="hs-grid hs-grid-2">
            <Input label="Day" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
            <Select label={t(locale, "booking_step_datetime")} value={startsAt} onChange={(event) => setStartsAt(event.target.value)}>
              {slots.map((slot) => (
                <option key={slot.startsAt} value={slot.startsAt}>
                  {new Date(slot.startsAt).toLocaleString(locale)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {step === "details" ? (
          <div className="hs-grid hs-grid-2">
            <Input label="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Input label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
            <Input label="First name" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
            <Input label="Last name" value={lastName} onChange={(event) => setLastName(event.target.value)} />
          </div>
        ) : null}

        {step === "payment" ? (
          <div className="hs-grid">
            <p>{t(locale, "booking_success")}</p>
            <Select label={t(locale, "booking_step_payment")} value={paymentMode} onChange={(event) => setPaymentMode(event.target.value as "deposit" | "full")}>
              <option value="deposit">Deposit (30%)</option>
              <option value="full">Full payment</option>
            </Select>
            {selectedService ? (
              <p style={{ color: "var(--hs-muted)" }}>
                Total: {(selectedService.priceCents / 100).toFixed(2)} EUR
              </p>
            ) : null}
            {googlePayReady && paymentId ? (
              <p style={{ color: "var(--hs-success)" }}>
                Google Pay checkout ready. Payment ID: {paymentId.slice(0, 12)}…
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
          {stepIndex > 0 ? (
            <Button type="button" variant="secondary" onClick={() => setStepIndex((value) => Math.max(0, value - 1))}>
              {t(locale, "cancel")}
            </Button>
          ) : null}
          <Button type="button" onClick={() => void nextStep()} disabled={loading}>
            {loading ? t(locale, "loading") : step === "payment" ? t(locale, "booking_confirm") : t(locale, "submit")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
