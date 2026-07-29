"use client";

import { useState } from "react";

type ReportData = {
  revenueCents: number;
  upcomingAppointments: number;
  pendingAppointments: number;
  cancelledAppointments: number;
  completedAppointments?: number;
  noShowAppointments?: number;
  dailyRevenue?: Array<{ label: string; value: number }>;
  byService?: Array<{ label: string; count: number; revenueCents?: number }>;
  byStaff?: Array<{ label: string; count: number; revenueCents?: number }>;
};

export function ReportsWorkspace({ initial }: { initial: ReportData }) {
  const [data, setData] = useState(initial);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(now.toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    const response = await fetch(`/api/reports?from=${from}&to=${to}`);
    const json = await response.json();
    if (response.ok) setData(json.data);
    setBusy(false);
  }

  const bars = data.dailyRevenue ?? [
    { label: "Revenue", value: data.revenueCents },
    { label: "Upcoming", value: data.upcomingAppointments * 1000 },
    { label: "Pending", value: data.pendingAppointments * 1000 },
    { label: "Cancelled", value: data.cancelledAppointments * 1000 },
  ];
  const max = Math.max(...bars.map((item) => item.value), 1);

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Revenue, utilization and performance broken down by service and team member.</p>
        <div className="admin-toolbar">
          <input className="admin-field" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <input className="admin-field" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          <button className="admin-button" disabled={busy} type="button" onClick={() => void load()}>{busy ? "Loading…" : "Apply"}</button>
          <a className="admin-button secondary" href={`/api/reports?from=${from}&to=${to}&format=csv`}>Export CSV</a>
        </div>
      </div>
      <div className="admin-metric-grid">
        <div className="admin-metric"><p>Revenue</p><strong>{(data.revenueCents / 100).toFixed(0)} €</strong><small>Paid total</small></div>
        <div className="admin-metric"><p>Upcoming</p><strong>{data.upcomingAppointments}</strong><small>Future bookings</small></div>
        <div className="admin-metric"><p>Pending</p><strong>{data.pendingAppointments}</strong><small>Need action</small></div>
        <div className="admin-metric"><p>Completed</p><strong>{data.completedAppointments ?? "—"}</strong><small>Finished visits</small></div>
        <div className="admin-metric"><p>Cancelled</p><strong>{data.cancelledAppointments}</strong><small>Lost bookings</small></div>
      </div>
      <section className="admin-panel admin-report-chart">
        <div className="admin-panel-header"><h2>Performance</h2><span>{from} — {to}</span></div>
        <div className="admin-bars">
          {bars.map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              <i style={{ height: `${Math.max(4, (item.value / max) * 100)}%` }} />
              <strong>{item.value > 1000 ? `${(item.value / 100).toFixed(0)} €` : item.value}</strong>
            </div>
          ))}
        </div>
      </section>
      <div className="admin-grid-2">
        <section className="admin-panel">
          <div className="admin-panel-header"><h2>By service</h2><span>Bookings</span></div>
          {(data.byService ?? []).map((entry) => <div className="admin-ranking-row" key={entry.label}><span>{entry.label}</span><strong>{entry.count}</strong></div>)}
          {!data.byService?.length ? <div className="admin-empty">Detailed service data appears after applying a report period.</div> : null}
        </section>
        <section className="admin-panel">
          <div className="admin-panel-header"><h2>By team member</h2><span>Bookings</span></div>
          {(data.byStaff ?? []).map((entry) => <div className="admin-ranking-row" key={entry.label}><span>{entry.label}</span><strong>{entry.count}</strong></div>)}
          {!data.byStaff?.length ? <div className="admin-empty">Detailed team data appears after applying a report period.</div> : null}
        </section>
      </div>
    </div>
  );
}
