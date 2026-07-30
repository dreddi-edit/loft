"use client";

import { useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { formatSalonDateTime } from "../lib/admin-datetime";

type RecurringRow = {
  id: string;
  active: boolean;
  intervalWeeks: number;
  nextAt: string;
  locale: string;
  channel: string;
  customer: { firstName: string; lastName: string; email: string | null };
  service: { slug: string; translations: Array<{ locale: string; name: string }> };
  staff: { displayName: string } | null;
};

type SeriesAction = "pause" | "resume" | "skip" | "end";

export function RecurringWorkspace({ locale }: { locale: AppLocale }) {
  const [items, setItems] = useState<RecurringRow[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [activeOnly]);

  async function load() {
    setError(null);
    const query = new URLSearchParams({ limit: "50" });
    if (activeOnly) query.set("active", "true");
    const response = await fetch(`/api/recurring?${query.toString()}`);
    const json = await response.json();
    if (!response.ok) {
      setError(json.message ?? "Could not load recurring series.");
      return;
    }
    setItems(json.data ?? []);
  }

  async function runAction(id: string, action: SeriesAction) {
    setBusy(`${id}:${action}`);
    setError(null);
    const response = await fetch(`/api/recurring/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        ...(action === "end" ? { cancelFutureAppointments: false } : {}),
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.message ?? `Could not ${action} series.`);
      setBusy(null);
      return;
    }
    await load();
    setBusy(null);
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Standing appointments materialised by the hourly sweep.</p>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} />
          Active only
        </label>
      </div>
      {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>Series</h2><span>{items.length}</span></div>
        <table className="admin-data-table">
          <thead>
            <tr>
              <th>Next</th>
              <th>Customer</th>
              <th>Service</th>
              <th>Staff</th>
              <th>Every</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{formatSalonDateTime(entry.nextAt, locale)}</td>
                <td>{entry.customer.firstName} {entry.customer.lastName}</td>
                <td>{entry.service.translations.find((tr) => tr.locale === locale)?.name ?? entry.service.slug}</td>
                <td>{entry.staff?.displayName ?? "Any"}</td>
                <td>{entry.intervalWeeks} wk</td>
                <td>
                  <span className={`admin-status ${entry.active ? "confirmed" : "cancelled"}`}>
                    {entry.active ? "active" : "paused"}
                  </span>
                </td>
                <td style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                  {entry.active ? (
                    <>
                      <button
                        className="admin-button secondary"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void runAction(entry.id, "pause")}
                      >
                        Pause
                      </button>
                      <button
                        className="admin-button secondary"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void runAction(entry.id, "skip")}
                      >
                        Skip next
                      </button>
                      <button
                        className="admin-button secondary"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void runAction(entry.id, "end")}
                      >
                        End
                      </button>
                    </>
                  ) : (
                    <button
                      className="admin-button secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void runAction(entry.id, "resume")}
                    >
                      Resume
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 ? <div className="admin-empty">No recurring series.</div> : null}
      </section>
    </div>
  );
}
