"use client";

import { useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";

type ReviewMetrics = {
  fromLabel: string;
  toLabel: string;
  created: number;
  sent: number;
  clicked: number;
  pending: number;
  clickRate: number;
  averageHoursToClick: number | null;
};

export function ReviewWorkspace({ locale }: { locale: AppLocale }) {
  const [metrics, setMetrics] = useState<ReviewMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [locale]);

  async function load() {
    setError(null);
    const query = new URLSearchParams({ locale });
    const response = await fetch(`/api/reviews/metrics?${query.toString()}`);
    const json = await response.json();
    if (!response.ok) {
      setError(json.message ?? "Could not load review metrics.");
      return;
    }
    setMetrics(json.data ?? null);
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Review asks sent after completed visits and click-through to Google.</p>
      </div>
      {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
      {metrics ? (
        <div className="admin-metric-grid">
          <div className="admin-metric"><p>Period</p><strong>{metrics.fromLabel}</strong><small>to {metrics.toLabel}</small></div>
          <div className="admin-metric"><p>Created</p><strong>{metrics.created}</strong><small>Requests queued</small></div>
          <div className="admin-metric"><p>Sent</p><strong>{metrics.sent}</strong><small>{metrics.pending} pending</small></div>
          <div className="admin-metric"><p>Clicked</p><strong>{metrics.clicked}</strong><small>{(metrics.clickRate * 100).toFixed(1)}% rate</small></div>
          <div className="admin-metric">
            <p>Avg. time to click</p>
            <strong>{metrics.averageHoursToClick ?? "—"}</strong>
            <small>hours after send</small>
          </div>
        </div>
      ) : (
        <div className="admin-empty">Loading review metrics…</div>
      )}
    </div>
  );
}
