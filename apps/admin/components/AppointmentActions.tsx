"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Appointment = {
  id: string;
  status: string;
  startsAt: string | Date;
  payments?: Array<{ id?: string; status: string; amountCents: number }>;
};

export function AppointmentActions({ appointment }: { appointment: Appointment }) {
  const router = useRouter();
  const [status, setStatus] = useState(appointment.status);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startsAt, setStartsAt] = useState(
    new Date(appointment.startsAt).toISOString().slice(0, 16),
  );

  async function runAction(action: "cancel" | "reschedule" | "confirm" | "no_show" | "complete") {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/appointments/${appointment.id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "admin action",
        startsAt: new Date(startsAt).toISOString(),
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? "Failed");
      setBusy(false);
      return;
    }
    setStatus(json.data.status);
    setMessage("Saved");
    setBusy(false);
    router.refresh();
  }

  async function refund() {
    const payment = appointment.payments?.find((entry) => entry.status === "paid" && entry.id);
    if (!payment?.id) return;
    setBusy(true);
    const response = await fetch("/api/payments/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId: payment.id, reason: "Admin refund" }),
    });
    const json = await response.json();
    setMessage(response.ok ? "Refund requested" : json.message ?? json.error ?? "Refund failed");
    setBusy(false);
    if (response.ok) router.refresh();
  }

  return (
    <div className="admin-appointment-actions">
      <select
        className="admin-select"
        value=""
        disabled={busy}
        onChange={(event) => {
          const action = event.target.value as "cancel" | "confirm" | "no_show" | "complete";
          if (action) void runAction(action);
        }}
        aria-label="Change appointment status"
      >
        <option value="">Actions</option>
        <option value="confirm">Confirm</option>
        <option value="complete">Complete</option>
        <option value="no_show">No-show</option>
        <option value="cancel">Cancel</option>
      </select>
      {appointment.payments?.some((payment) => payment.status === "paid") ? (
        <button className="admin-mini-danger" type="button" disabled={busy} onClick={() => void refund()}>Refund</button>
      ) : null}
      <details className="admin-reschedule">
        <summary>Move</summary>
        <div>
          <input
            className="admin-field"
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
          />
          <button className="admin-button" type="button" disabled={busy} onClick={() => void runAction("reschedule")}>
            Save
          </button>
        </div>
      </details>
      {message ? <span className="admin-inline-message">{status} · {message}</span> : null}
    </div>
  );
}
