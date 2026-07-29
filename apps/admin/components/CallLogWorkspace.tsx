"use client";

import { useMemo, useState } from "react";

type CallLog = {
  id: string;
  locale: string;
  fromNumber: string | null;
  toNumber: string | null;
  summary: string;
  actionTaken: string;
  fallback: boolean;
  createdAt: string | Date;
  customer: { firstName: string; lastName: string; phone: string | null } | null;
};

export function CallLogWorkspace({ calls }: { calls: CallLog[] }) {
  const [query, setQuery] = useState("");
  const [fallbackOnly, setFallbackOnly] = useState(false);
  const visible = useMemo(() => {
    const needle = query.toLowerCase();
    return calls.filter((call) => {
      const haystack = `${call.summary} ${call.actionTaken} ${call.fromNumber ?? ""} ${call.customer?.firstName ?? ""} ${call.customer?.lastName ?? ""}`.toLowerCase();
      return haystack.includes(needle) && (!fallbackOnly || call.fallback);
    });
  }, [calls, fallbackOnly, query]);

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Inbound and outbound voice activity with outcomes and linked customers.</p>
        <div className="admin-toolbar">
          <input className="admin-field" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search calls" />
          <label className="admin-check"><input type="checkbox" checked={fallbackOnly} onChange={(event) => setFallbackOnly(event.target.checked)} />Fallback only</label>
        </div>
      </div>
      <section className="admin-timeline">
        {visible.map((entry) => (
          <article key={entry.id}>
            <time>{new Date(entry.createdAt).toLocaleString("en")}</time>
            <div>
              <span className="admin-kicker">{entry.locale} · {entry.fromNumber ?? "Unknown caller"}</span>
              <h2>{entry.summary}</h2>
              <p>{entry.actionTaken}</p>
              {entry.customer ? <small>Linked to {entry.customer.firstName} {entry.customer.lastName}</small> : null}
            </div>
            <span className={`admin-status ${entry.fallback ? "failed" : "sent"}`}>{entry.fallback ? "Fallback" : "Handled"}</span>
          </article>
        ))}
        {visible.length === 0 ? <div className="admin-empty">No call activity matches this view.</div> : null}
      </section>
    </div>
  );
}
