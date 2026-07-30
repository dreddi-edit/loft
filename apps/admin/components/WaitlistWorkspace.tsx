"use client";

import { useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { formatSalonDateTime } from "../lib/admin-datetime";

type WaitlistEntry = {
  id: string;
  status: string;
  earliestAt: string;
  latestAt: string;
  locale: string;
  channel: string;
  notifiedAt: string | null;
  createdAt: string;
  customer: { firstName: string; lastName: string; email: string | null; phone: string | null };
  service: { slug: string; translations: Array<{ locale: string; name: string }> };
  staff: { displayName: string } | null;
};

export function WaitlistWorkspace({ locale }: { locale: AppLocale }) {
  const [items, setItems] = useState<WaitlistEntry[]>([]);
  const [status, setStatus] = useState("active");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [status]);

  async function load() {
    setError(null);
    const query = new URLSearchParams({ limit: "50" });
    if (status !== "all") query.set("status", status);
    const response = await fetch(`/api/waitlist?${query.toString()}`);
    const json = await response.json();
    if (!response.ok) {
      setError(json.message ?? "Could not load waitlist.");
      return;
    }
    setItems(json.data ?? []);
  }

  async function cancelEntry(id: string) {
    setBusy(id);
    const response = await fetch(`/api/waitlist/${id}`, { method: "DELETE" });
    if (response.ok) setItems((current) => current.filter((entry) => entry.id !== id));
    setBusy(null);
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Fairness-ordered queue of customers waiting for an opening.</p>
        <select className="admin-select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="notified">Notified</option>
          <option value="converted">Converted</option>
          <option value="expired">Expired</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>Queue</h2><span>{items.length} entries</span></div>
        <table className="admin-data-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Customer</th>
              <th>Service</th>
              <th>Window</th>
              <th>Staff</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{formatSalonDateTime(entry.createdAt, locale)}</td>
                <td>{entry.customer.firstName} {entry.customer.lastName}</td>
                <td>{entry.service.translations.find((tr) => tr.locale === locale)?.name ?? entry.service.slug}</td>
                <td>
                  {formatSalonDateTime(entry.earliestAt, locale)} – {formatSalonDateTime(entry.latestAt, locale)}
                </td>
                <td>{entry.staff?.displayName ?? "Any"}</td>
                <td><span className={`admin-status ${entry.status}`}>{entry.status}</span></td>
                <td>
                  {entry.status === "active" || entry.status === "notified" ? (
                    <button
                      className="admin-button secondary"
                      type="button"
                      disabled={busy === entry.id}
                      onClick={() => void cancelEntry(entry.id)}
                    >
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 ? <div className="admin-empty">No waitlist entries.</div> : null}
      </section>
    </div>
  );
}
