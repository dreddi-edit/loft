"use client";

import { FormEvent, useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { formatSalonDateTime } from "../lib/admin-datetime";

type DataRequestRow = {
  id: string;
  customerId: string;
  type: string;
  status: string;
  requestedBy: string;
  hasResult: boolean;
  error: string | null;
  completedAt: string | null;
  createdAt: string;
};

export function GdprWorkspace({ locale }: { locale: AppLocale }) {
  const [items, setItems] = useState<DataRequestRow[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [requestType, setRequestType] = useState<"export" | "erasure">("export");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const response = await fetch("/api/gdpr/requests?limit=50");
    const json = await response.json();
    if (response.ok) setItems(json.data ?? []);
  }

  async function createRequest(event: FormEvent) {
    event.preventDefault();
    if (!customerId.trim()) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/gdpr/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: customerId.trim(), type: requestType }),
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.message ?? "Could not create request.");
      setBusy(false);
      return;
    }
    setCustomerId("");
    await load();
    setBusy(false);
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Art. 15/17 export and erasure requests tracked through completion.</p>
      </div>
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>New request</h2></div>
        <form className="admin-form" onSubmit={(event) => void createRequest(event)}>
          <label>
            Customer ID
            <input className="admin-input" value={customerId} onChange={(event) => setCustomerId(event.target.value)} />
          </label>
          <label>
            Type
            <select className="admin-select" value={requestType} onChange={(event) => setRequestType(event.target.value as "export" | "erasure")}>
              <option value="export">Export</option>
              <option value="erasure">Erasure</option>
            </select>
          </label>
          <button className="admin-button" type="submit" disabled={busy}>Create</button>
        </form>
        {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
      </section>
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>Queue</h2><span>{items.length}</span></div>
        <table className="admin-data-table">
          <thead><tr><th>Created</th><th>Customer</th><th>Type</th><th>Status</th><th>Requested by</th><th>Result</th></tr></thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{formatSalonDateTime(entry.createdAt, locale)}</td>
                <td>{entry.customerId}</td>
                <td>{entry.type}</td>
                <td><span className={`admin-status ${entry.status}`}>{entry.status}</span></td>
                <td>{entry.requestedBy}</td>
                <td>{entry.hasResult ? "ready" : entry.error ?? "pending"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
