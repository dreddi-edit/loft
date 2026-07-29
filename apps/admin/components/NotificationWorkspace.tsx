"use client";

import { useMemo, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { formatSalonDateTime } from "../lib/admin-datetime";

type Notification = {
  id: string;
  channel: string;
  recipient: string;
  templateKey: string;
  payload: unknown;
  sentAt: string | Date | null;
  createdAt: string | Date;
};

export function NotificationWorkspace({
  notifications,
  locale,
}: {
  notifications: Notification[];
  locale: AppLocale;
}) {
  const [channel, setChannel] = useState("all");
  const [items, setItems] = useState(notifications);
  const [busy, setBusy] = useState<string | null>(null);
  const visible = useMemo(
    () => items.filter((notification) => channel === "all" || notification.channel === channel),
    [items, channel],
  );

  async function retry(id: string) {
    setBusy(id);
    const response = await fetch(`/api/notifications/${id}/retry`, { method: "POST" });
    const json = await response.json();
    if (response.ok) setItems((current) => current.map((item) => item.id === id ? { ...item, ...json.data } : item));
    setBusy(null);
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Delivery audit for email, SMS, WhatsApp and voice notifications.</p>
        <select className="admin-select" value={channel} onChange={(event) => setChannel(event.target.value)}>
          <option value="all">All channels</option>
          <option value="web">Web</option>
          <option value="sms">SMS</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="voice">Voice</option>
        </select>
      </div>
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>Delivery stream</h2><span>{visible.length} records</span></div>
        <table className="admin-data-table">
          <thead><tr><th>Created</th><th>Template</th><th>Recipient</th><th>Channel</th><th>Status</th><th>Payload</th><th /></tr></thead>
          <tbody>
            {visible.map((entry) => (
              <tr key={entry.id}>
                <td>{formatSalonDateTime(entry.createdAt, locale)}</td>
                <td>{entry.templateKey}</td>
                <td>{entry.recipient}</td>
                <td>{entry.channel}</td>
                <td><span className={`admin-status ${entry.sentAt ? "sent" : "pending"}`}>{entry.sentAt ? "Sent" : "Pending"}</span></td>
                <td>
                  <details className="admin-payload">
                    <summary>View</summary>
                    <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
                  </details>
                </td>
                <td>{!entry.sentAt ? <button className="admin-button secondary" disabled={busy === entry.id} type="button" onClick={() => void retry(entry.id)}>Retry</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
