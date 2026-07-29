"use client";

import { useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Button, Card, Input } from "@hair-simo/ui";
import {
  SALON_TIME_ZONE,
  formatSalonDateTime,
  fromSalonWallClock,
  isSalonWallClock,
  toSalonWallClock,
} from "../lib/web-datetime";

type Appointment = {
  id: string;
  status: string;
  startsAt: string;
  service: { slug: string; translations: { locale: string; name: string }[] };
  customer: { firstName: string; lastName: string; email: string | null };
};

const timeZoneNotice: Record<AppLocale, string> = {
  de: `Zeiten in Ortszeit Brixen (${SALON_TIME_ZONE}).`,
  it: `Orari nell'ora locale di Bressanone (${SALON_TIME_ZONE}).`,
  fr: `Horaires a l'heure locale de Bressanone (${SALON_TIME_ZONE}).`,
  en: `Times in Brixen local time (${SALON_TIME_ZONE}).`,
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
        if (json.data?.startsAt) setStartsAt(toSalonWallClock(json.data.startsAt));
      });
  }, [token]);

  async function runAction(action: "cancel" | "reschedule") {
    setMessage(null);
    // The input holds a bare salon wall clock, so it is resolved against the salon zone
    // and never against whatever zone the customer's browser happens to be in.
    let requestedStartsAt: string | undefined;
    if (action === "reschedule") {
      if (!isSalonWallClock(startsAt)) {
        setMessage(t(locale, "error_generic"));
        return;
      }
      requestedStartsAt = fromSalonWallClock(startsAt).toISOString();
    }
    setLoading(true);
    const response = await fetch(`/api/appointment/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        reason,
        startsAt: requestedStartsAt,
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
        {serviceName} · {formatSalonDateTime(appointment.startsAt, locale)} · {appointment.status}
      </p>
      {appointment.status !== "cancelled" ? (
        <div className="hs-grid" style={{ marginTop: "1rem" }}>
          <Input
            label={t(locale, "manage_new_time")}
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
          />
          <p style={{ color: "var(--hs-muted)", margin: 0 }}>{timeZoneNotice[locale]}</p>
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
