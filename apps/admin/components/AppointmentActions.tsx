"use client";

import { useState } from "react";
import { Button } from "@hair-simo/ui";

type Appointment = {
  id: string;
  status: string;
  startsAt: string | Date;
};

export function AppointmentActions({ appointment }: { appointment: Appointment }) {
  const [status, setStatus] = useState(appointment.status);
  const [message, setMessage] = useState<string | null>(null);

  async function runAction(action: "cancel" | "reschedule" | "confirm" | "no_show" | "complete") {
    const response = await fetch(`/api/appointments/${appointment.id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "admin action",
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? "Failed");
      return;
    }
    setStatus(json.data.status);
    setMessage(`Updated to ${json.data.status}`);
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
      <Button type="button" onClick={() => void runAction("confirm")}>Confirm</Button>
      <Button type="button" variant="secondary" onClick={() => void runAction("reschedule")}>Reschedule +1d</Button>
      <Button type="button" variant="secondary" onClick={() => void runAction("cancel")}>Cancel</Button>
      <Button type="button" variant="secondary" onClick={() => void runAction("no_show")}>No-show</Button>
      <Button type="button" variant="secondary" onClick={() => void runAction("complete")}>Complete</Button>
      {message ? <span style={{ color: "var(--hs-muted)" }}>{status} · {message}</span> : null}
    </div>
  );
}
