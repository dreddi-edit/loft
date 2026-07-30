"use client";

import { FormEvent, useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";

type VoucherRow = {
  id: string;
  codeSuffix: string;
  initialCents: number;
  remainingCents: number;
  currency: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
};

export function VoucherWorkspace({ locale }: { locale: AppLocale }) {
  void locale;
  const [items, setItems] = useState<VoucherRow[]>([]);
  const [amount, setAmount] = useState("50");
  const [busy, setBusy] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const response = await fetch("/api/vouchers?limit=50");
    const json = await response.json();
    if (response.ok) setItems(json.data ?? []);
  }

  async function issueVoucher(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setIssuedCode(null);
    const cents = Math.round(Number(amount) * 100);
    const response = await fetch("/api/vouchers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialCents: cents, currency: "EUR" }),
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.message ?? "Could not issue voucher.");
      setBusy(false);
      return;
    }
    setIssuedCode(json.data?.code ?? null);
    await load();
    setBusy(false);
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Gift cards issued by the salon. Full codes are shown once at issue time.</p>
      </div>
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>Issue voucher</h2></div>
        <form className="admin-form" onSubmit={(event) => void issueVoucher(event)}>
          <label>
            Amount (EUR)
            <input className="admin-input" type="number" min="1" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>
          <button className="admin-button" type="submit" disabled={busy}>Issue</button>
        </form>
        {issuedCode ? <p><strong>New code:</strong> <code>{issuedCode}</code></p> : null}
        {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
      </section>
      <section className="admin-panel">
        <div className="admin-panel-header"><h2>Outstanding vouchers</h2><span>{items.length}</span></div>
        <table className="admin-data-table">
          <thead><tr><th>Created</th><th>Suffix</th><th>Initial</th><th>Remaining</th><th>Status</th><th>Expires</th></tr></thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>…{entry.codeSuffix}</td>
                <td>{(entry.initialCents / 100).toFixed(2)} {entry.currency}</td>
                <td>{(entry.remainingCents / 100).toFixed(2)} {entry.currency}</td>
                <td><span className={`admin-status ${entry.status}`}>{entry.status}</span></td>
                <td>{entry.expiresAt ? new Date(entry.expiresAt).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
