"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Badge, Button, Card, Input, PageHeader, Select } from "@hair-simo/ui";
import {
  SALON_TIME_ZONE,
  formatSalonClock,
  formatSalonClockWithZone,
  formatSalonDateTime,
  isSalonDayKey,
  salonTodayKey,
} from "../lib/web-datetime";

type Service = {
  id: string;
  slug: string;
  durationMin: number;
  priceCents: number;
  translations: { locale: string; name: string; description: string }[];
};

type Staff = { id: string; displayName: string };
type Slot = { startsAt: string; endsAt: string };

type PublicConfig = {
  gcpEnabled: boolean;
  paymentsMockEnabled: boolean;
  googlePayConfigured: boolean;
  environment: string;
};

const steps = ["service", "stylist", "datetime", "details", "payment"] as const;

const timeZoneNotice: Record<AppLocale, string> = {
  de: `Alle Zeiten in Ortszeit Brixen (${SALON_TIME_ZONE}).`,
  it: `Tutti gli orari sono nell'ora locale di Bressanone (${SALON_TIME_ZONE}).`,
  fr: `Tous les horaires sont a l'heure locale de Bressanone (${SALON_TIME_ZONE}).`,
  en: `All times are in Brixen local time (${SALON_TIME_ZONE}).`,
};

export function BookingWizard({ locale }: { locale: AppLocale }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);

  const [serviceSlug, setServiceSlug] = useState("");
  const [staffId, setStaffId] = useState("");
  const [day, setDay] = useState(() => salonTodayKey());
  const [startsAt, setStartsAt] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentMode, setPaymentMode] = useState<"deposit" | "full">("deposit");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [manageUrl, setManageUrl] = useState<string | null>(null);
  const [waitlistJoined, setWaitlistJoined] = useState(false);
  const [waitlistLatestDay, setWaitlistLatestDay] = useState("");
  const [voucherCode, setVoucherCode] = useState("");
  const [voucherBalance, setVoucherBalance] = useState<{
    remainingCents: number;
    currency: string;
    status: string;
    expiresAt: string | null;
  } | null>(null);

  const step = steps[stepIndex];
  const lastCheckoutKey = useRef<string | null>(null);
  const selectedService = useMemo(
    () => services.find((entry) => entry.slug === serviceSlug),
    [services, serviceSlug],
  );
  const selectedStaff = useMemo(() => staff.find((entry) => entry.id === staffId), [staff, staffId]);

  function presentError(message: string) {
    if (message.includes("SLOT_NOT_AVAILABLE")) return "Der Slot ist leider nicht mehr verfuegbar. Bitte waehle einen anderen Termin.";
    if (message.includes("STAFF_NOT_ELIGIBLE")) return "Diese Mitarbeiterin ist fuer den Service nicht verfuegbar.";
    if (message.includes("TERMS_NOT_ACCEPTED")) return "Bitte akzeptiere die Bedingungen, um fortzufahren.";
    if (message.includes("SERVICE_NOT_FOUND")) return "Der Service wurde nicht gefunden.";
    return message;
  }

  useEffect(() => {
    void fetch("/api/config/public")
      .then((res) => res.json())
      .then((json) => setConfig(json.data ?? null))
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    void ensureCatalogLoaded();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedService = params.get("service");
    const requestedDate = params.get("date");
    if (requestedService) setServiceSlug(requestedService);
    if (requestedDate && isSalonDayKey(requestedDate)) setDay(requestedDate.trim());
  }, []);

  useEffect(() => {
    if (step !== "payment") {
      lastCheckoutKey.current = null;
      return;
    }
    if (!appointmentId || paymentComplete) return;
    if (voucherCode.trim() && !voucherBalance) return;
    const checkoutKey = `${appointmentId}:${paymentMode}:${voucherBalance?.remainingCents ?? "none"}`;
    if (lastCheckoutKey.current === checkoutKey) return;
    lastCheckoutKey.current = checkoutKey;
    void createGooglePayCheckout();
  }, [step, appointmentId, paymentComplete, paymentMode, voucherBalance, voucherCode]);

  async function ensureCatalogLoaded() {
    if (services.length > 0) return;
    const [servicesRes, staffRes] = await Promise.all([
      fetch("/api/services"),
      fetch("/api/staff").catch(() => null),
    ]);
    const servicesJson = await servicesRes.json();
    const loadedServices = servicesJson.data ?? [];
    setServices(loadedServices);
    setServiceSlug((current) => current || loadedServices[0]?.slug || "");
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
      // The salon day key is sent as-is: an instant would have to guess an hour, and any
      // guess lands on the wrong salon day for part of the world.
      const query = new URLSearchParams({ serviceSlug, day });
      if (staffId) query.set("staffId", staffId);
      const response = await fetch(`/api/availability?${query.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "AVAILABILITY_ERROR");
      setSlots(json.data ?? []);
      if (json.data?.[0]) {
        setStartsAt((current) => current || json.data[0].startsAt);
      } else {
        setStartsAt("");
      }
    } catch (err) {
      setError(err instanceof Error ? presentError(err.message) : t(locale, "error_generic"));
    } finally {
      setLoading(false);
    }
  }

  async function joinWaitlist() {
    if (!selectedService || !email || !termsAccepted) {
      setError("Bitte Service, E-Mail und Bedingungen ausfuellen.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const earliestAt = new Date(`${day}T08:00:00`);
      const latestDay = waitlistLatestDay || day;
      const latestAt = new Date(`${latestDay}T20:00:00`);
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceSlug,
          staffId: staffId || undefined,
          earliestAt: earliestAt.toISOString(),
          latestAt: latestAt.toISOString(),
          customerEmail: email,
          customerFirstName: firstName || undefined,
          customerLastName: lastName || undefined,
          customerPhone: phone || undefined,
          locale,
          channel: "web",
          termsAccepted,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "WAITLIST_JOIN_FAILED");
      setWaitlistJoined(true);
    } catch (err) {
      setError(err instanceof Error ? presentError(err.message) : t(locale, "error_generic"));
    } finally {
      setLoading(false);
    }
  }

  async function checkVoucherBalance() {
    if (!voucherCode.trim()) return;
    setLoading(true);
    setError(null);
    setVoucherBalance(null);
    try {
      const response = await fetch(`/api/vouchers/balance?code=${encodeURIComponent(voucherCode.trim())}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "VOUCHER_LOOKUP_FAILED");
      setVoucherBalance(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? presentError(err.message) : t(locale, "error_generic"));
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
          termsAccepted,
          marketingOptIn,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "BOOKING_CREATE_FAILED");
      setAppointmentId(json.data.id);
      if (json.data.manageUrl) setManageUrl(json.data.manageUrl);
      setStepIndex(4);
    } catch (err) {
      setError(err instanceof Error ? presentError(err.message) : t(locale, "error_generic"));
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
          mode: paymentMode,
          ...(voucherBalance ? { voucherCode: voucherCode.trim() } : {}),
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "PAYMENT_CHECKOUT_FAILED");
      if (json.data.paymentRequired) {
        setPaymentId(json.data.paymentId);
      } else {
        setPaymentId(null);
        setPaymentComplete(true);
      }
      setAmountCents(json.data.totalChargeCents);
    } catch (err) {
      setError(err instanceof Error ? presentError(err.message) : t(locale, "error_generic"));
    } finally {
      setLoading(false);
    }
  }

  async function confirmMockPayment() {
    if (!paymentId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/payments/confirm-mock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? "MOCK_PAYMENT_FAILED");
      setPaymentComplete(true);
    } catch (err) {
      setError(err instanceof Error ? presentError(err.message) : t(locale, "error_generic"));
    } finally {
      setLoading(false);
    }
  }

  async function nextStep() {
    setError(null);
    if (step === "service") {
      if (!serviceSlug) {
        setError("Bitte zuerst einen Service waehlen.");
        return;
      }
      setStepIndex(1);
      return;
    }
    if (step === "stylist") {
      setStepIndex(2);
      return;
    }
    if (step === "datetime") {
      if (!startsAt) {
        if (slots.length === 0) {
          setStepIndex(3);
          return;
        }
        setError("Bitte waehle einen verfuegbaren Termin.");
        return;
      }
      setStepIndex(3);
      return;
    }
    if (step === "details") {
      if (!startsAt) {
        await joinWaitlist();
        return;
      }
      await createBooking();
    }
  }

  const showMockPayment = config?.paymentsMockEnabled && paymentId && !paymentComplete;
  const showGooglePayHint = config?.googlePayConfigured && paymentId && !paymentComplete;

  useEffect(() => {
    if (step !== "datetime" || !serviceSlug || !day) return;
    void loadSlots();
  }, [step, serviceSlug, staffId, day]);

  return (
    <div className="hs-booking-shell">
      <PageHeader title={t(locale, "booking_title")} subtitle={t(locale, "hero_subtitle")} />
      <div className="hs-booking-stepper">
        {steps.map((entry, index) => (
          <Badge key={entry}>{index <= stepIndex ? "✓" : "•"} {t(locale, `booking_step_${entry}` as never)}</Badge>
        ))}
      </div>

      <div className="hs-booking-layout">
      <Card className="hs-booking-card">
        {step === "service" ? (
          <Select label={t(locale, "booking_step_service")} value={serviceSlug} onChange={(event) => setServiceSlug(event.target.value)}>
            {services.map((service) => (
              <option key={service.slug} value={service.slug}>
                {service.translations.find((tr) => tr.locale === locale)?.name ?? service.slug} (
                {(service.priceCents / 100).toFixed(2)} EUR)
              </option>
            ))}
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
              <option value="">{loading ? "Lade Zeiten..." : "Bitte Slot waehlen"}</option>
              {slots.map((slot) => (
                <option key={slot.startsAt} value={slot.startsAt}>
                  {formatSalonDateTime(slot.startsAt, locale)}
                </option>
              ))}
            </Select>
            <div className="hs-booking-slot-grid" style={{ gridColumn: "1 / -1" }}>
              {slots.slice(0, 12).map((slot) => (
                <button
                  key={slot.startsAt}
                  type="button"
                  className={`hs-booking-slot ${startsAt === slot.startsAt ? "active" : ""}`}
                  onClick={() => setStartsAt(slot.startsAt)}
                >
                  {formatSalonClock(slot.startsAt, locale)}
                </button>
              ))}
            </div>
            {!loading && slots.length === 0 ? (
              <div style={{ gridColumn: "1 / -1", padding: "1rem", border: "1px solid var(--hs-border)", borderRadius: "12px" }}>
                <p style={{ marginTop: 0 }}>Keine freien Termine an diesem Tag. Trag dich in die Warteliste ein.</p>
                <p style={{ color: "var(--hs-muted)" }}>Du kannst im naechsten Schritt deine Kontaktdaten eingeben und dich benachrichtigen lassen.</p>
              </div>
            ) : null}
            <p style={{ color: "var(--hs-muted)", gridColumn: "1 / -1", margin: 0 }}>
              {timeZoneNotice[locale]}
            </p>
          </div>
        ) : null}

        {step === "details" ? (
          <div className="hs-grid hs-grid-2">
            <Input label="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Input label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
            <Input label="First name" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
            <Input label="Last name" value={lastName} onChange={(event) => setLastName(event.target.value)} />
            {!startsAt ? (
              <div style={{ gridColumn: "1 / -1" }}>
                <Input
                  label="Warteliste bis (Tag)"
                  type="date"
                  value={waitlistLatestDay}
                  onChange={(event) => setWaitlistLatestDay(event.target.value)}
                />
              </div>
            ) : null}
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", gridColumn: "1 / -1" }}>
              <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} required />
              <span>{t(locale, "booking_terms")}</span>
            </label>
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", gridColumn: "1 / -1" }}>
              <input type="checkbox" checked={marketingOptIn} onChange={(event) => setMarketingOptIn(event.target.checked)} />
              <span>{t(locale, "booking_marketing")}</span>
            </label>
            {waitlistJoined ? (
              <p style={{ color: "var(--hs-success)", gridColumn: "1 / -1" }}>
                Du stehst auf der Warteliste. Wir melden uns per E-Mail, sobald ein Termin frei wird.
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "payment" ? (
          <div className="hs-grid">
            {paymentComplete ? (
              <div>
                <p style={{ color: "var(--hs-success)" }}>{t(locale, "payment_paid")}</p>
                {manageUrl ? (
                  <p>
                    <a href={manageUrl}>{t(locale, "booking_manage_link")}</a>
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <p>{t(locale, "booking_success")}</p>
                {manageUrl ? (
                  <p>
                    <a href={manageUrl}>{t(locale, "booking_manage_link")}</a>
                  </p>
                ) : null}
                <Select
                  label={t(locale, "booking_step_payment")}
                  value={paymentMode}
                  onChange={(event) => {
                    setPaymentMode(event.target.value as "deposit" | "full");
                    setPaymentId(null);
                    lastCheckoutKey.current = null;
                  }}
                >
                  <option value="deposit">Deposit (30%)</option>
                  <option value="full">Full payment</option>
                </Select>
                <div className="hs-grid hs-grid-2" style={{ gridColumn: "1 / -1" }}>
                  <Input
                    label="Gutscheincode"
                    value={voucherCode}
                    onChange={(event) => {
                      setVoucherCode(event.target.value);
                      setVoucherBalance(null);
                      setPaymentId(null);
                      lastCheckoutKey.current = null;
                    }}
                  />
                  <div style={{ display: "flex", alignItems: "flex-end" }}>
                    <Button type="button" variant="secondary" onClick={() => void checkVoucherBalance()} disabled={loading || !voucherCode.trim()}>
                      Guthaben pruefen
                    </Button>
                  </div>
                </div>
                {voucherBalance ? (
                  <p style={{ color: "var(--hs-muted)", gridColumn: "1 / -1" }}>
                    Gutschein-Guthaben: {(voucherBalance.remainingCents / 100).toFixed(2)} {voucherBalance.currency}
                    {voucherBalance.expiresAt ? ` · gueltig bis ${new Date(voucherBalance.expiresAt).toLocaleDateString()}` : ""}
                  </p>
                ) : null}
                {amountCents !== null ? (
                  <p style={{ color: "var(--hs-muted)" }}>
                    {t(locale, "payment_amount")}: {(amountCents / 100).toFixed(2)} EUR
                  </p>
                ) : selectedService ? (
                  <p style={{ color: "var(--hs-muted)" }}>
                    {t(locale, "payment_amount")}: {(selectedService.priceCents / 100).toFixed(2)} EUR
                  </p>
                ) : null}
                {showMockPayment ? (
                  <Button type="button" onClick={() => void confirmMockPayment()} disabled={loading}>
                    {t(locale, "payment_mock")}
                  </Button>
                ) : null}
                {showGooglePayHint ? (
                  <p style={{ color: "var(--hs-muted)" }}>{t(locale, "payment_google_pay")} — SDK ready after merchant setup</p>
                ) : null}
                {!paymentId && !paymentComplete && loading ? (
                  <p style={{ color: "var(--hs-muted)" }}>{t(locale, "payment_checkout")}…</p>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
          {stepIndex > 0 && step !== "payment" ? (
            <Button type="button" variant="secondary" onClick={() => setStepIndex((value) => Math.max(0, value - 1))}>
              {t(locale, "cancel")}
            </Button>
          ) : null}
          {step !== "payment" ? (
            <Button type="button" onClick={() => void nextStep()} disabled={loading || (step === "details" && !termsAccepted) || (step === "details" && !startsAt && waitlistJoined)}>
              {loading ? t(locale, "loading") : !startsAt && step === "details" ? "Auf Warteliste" : t(locale, "submit")}
            </Button>
          ) : null}
        </div>
      </Card>
      <Card className="hs-booking-summary-card">
        <h3 className="hs-display" style={{ marginTop: 0, fontSize: "1.6rem" }}>Zusammenfassung</h3>
        <p><strong>Service:</strong> {selectedService?.translations.find((tr) => tr.locale === locale)?.name ?? "-"}</p>
        <p><strong>Mitarbeiterin:</strong> {selectedStaff?.displayName ?? t(locale, "booking_any_stylist")}</p>
        <p><strong>Datum:</strong> {day || "-"}</p>
        <p><strong>Zeit:</strong> {startsAt ? formatSalonClockWithZone(startsAt, locale) : "-"}</p>
        <p><strong>Preis:</strong> {selectedService ? `${(selectedService.priceCents / 100).toFixed(2)} EUR` : "-"}</p>
        <p style={{ color: "var(--hs-muted)", marginBottom: 0 }}>Status: {loading ? "wird verarbeitet..." : "bereit"}</p>
      </Card>
      </div>
    </div>
  );
}
