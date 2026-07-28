"use client";

import { useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Button, Card, Input } from "@hair-simo/ui";

type Appointment = {
  id: string;
  status: string;
  startsAt: string;
  service: { slug: string; translations: { locale: string; name: string }[] };
  customer: { firstName: string; lastName: string; email: string | null };
};

export function ManageAppointment({ locale, token }: { locale: AppLocale; token: string }) {
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [startsAt, setStartsAt] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetch(`/api/appointment/${token}`)
      .then((res) => res.json())
      .then((json) => {
        setAppointment(json.data ?? null);
        if (json.data?.startsAt) setStartsAt(new Date(json.data.startsAt).toISOString().slice(0, 16));
      });
  }, [token]);

  async function runAction(action: "cancel" | "reschedule") {
    setLoading(true);
    setMessage(null);
    const response = await fetch(`/api/appointment/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        reason,
        startsAt: new Date(startsAt).toISOString(),
      }),
    });
    const json = await response.json();
    setLoading(false);
    if (!response.ok) {
      setMessage(json.message ?? t(locale, "error_generic"));
      return;
    }
    setAppointment(json.data);
    setMessage(action === "cancel" ? t(locale, "manage_cancelled") : t(locale, "manage_rescheduled"));
  }

  if (!appointment) return <p>{t(locale, "loading")}</p>;

  const serviceName =
    appointment.service.translations.find((entry) => entry.locale === locale)?.name ?? appointment.service.slug;

  return (
    <Card>
      <h2>{t(locale, "manage_title")}</h2>
      <p style={{ color: "var(--hs-muted)" }}>
        {serviceName} · {new Date(appointment.startsAt).toLocaleString(locale)} · {appointment.status}
      </p>
      {appointment.status !== "cancelled" ? (
        <div className="hs-grid" style={{ marginTop: "1rem" }}>
          <Input
            label={t(locale, "manage_new_time")}
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
          />
          <Input label={t(locale, "manage_reason")} value={reason} onChange={(event) => setReason(event.target.value)} />
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <Button type="button" disabled={loading} onClick={() => void runAction("reschedule")}>
              {t(locale, "manage_reschedule")}
            </Button>
            <Button type="button" variant="secondary" disabled={loading} onClick={() => void runAction("cancel")}>
              {t(locale, "manage_cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? <p style={{ color: "var(--hs-success)" }}>{message}</p> : null}
    </Card>
  );
}
