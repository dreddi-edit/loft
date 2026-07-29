"use client";

import { useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { formatSalonDateTime } from "../lib/admin-datetime";

type AuditRow = {
  id: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};

export function AuditWorkspace({ locale }: { locale: AppLocale }) {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [entityType, setEntityType] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [entityType]);

  async function load() {
    setError(null);
    const query = new URLSearchParams({ limit: "50" });
    if (entityType) query.set("entityType", entityType);
    const response = await fetch(`/api/audit-log?${query.toString()}`);
    const json = await response.json();
    if (!response.ok) {
      setError(json.message ?? "Could not load audit log.");
      return;
    }
    setItems(json.data ?? []);
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Immutable trail of operator actions across the salon.</p>
        <input
          className="admin-input"
          placeholder="Filter by entity type"
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
        />
      </div>
      {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>Recent actions</h2><span>{items.length}</span></div>
        <table className="admin-data-table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{formatSalonDateTime(entry.createdAt, locale)}</td>
                <td>{entry.actorEmail} ({entry.actorRole})</td>
                <td>{entry.action}</td>
                <td>{entry.entityType} / {entry.entityId}</td>
                <td>
                  <details className="admin-payload">
                    <summary>View</summary>
                    <pre>{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 ? <div className="admin-empty">No audit entries.</div> : null}
      </section>
    </div>
  );
}
