"use client";

import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { SUPPORTED_LOCALES } from "@hair-simo/i18n";
import { adminT } from "../lib/admin-messages";

const labels: Record<string, string> = {
  dashboard: "Dashboard",
  calendar: "Calendar",
  appointments: "Appointments",
  customers: "Customers",
  services: "Services",
  staff: "Team",
  rules: "Rules",
  products: "Products",
  reports: "Reports",
  "call-logs": "Calls",
  notifications: "Notifications",
};

export function AdminTopbar({ locale }: { locale: AppLocale }) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const section = pathname.split("/")[1] || "dashboard";
  const titleKey =
    section === "dashboard" ? "dashboard" :
    section === "calendar" ? "calendar" :
    section === "appointments" ? "appointments" :
    section === "customers" ? "customers" :
    section === "services" ? "services" :
    section === "staff" ? "staff" :
    section === "rules" ? "rules" :
    section === "products" ? "products" :
    section === "reports" ? "reports" :
    section === "call-logs" ? "call_logs" :
    section === "notifications" ? "notifications" :
    null;
  const title = titleKey ? adminT(locale, titleKey) : labels[section] ?? "Hair Simo";
  const today = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(new Date()),
    [locale],
  );

  function search(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    router.push(`/customers?q=${encodeURIComponent(value)}`);
  }

  return (
    <header className="admin-topbar">
      <div>
        <p>{today}</p>
        <h1>{title}</h1>
      </div>
      <div className="admin-topbar-actions">
        <select
          className="admin-locale-select"
          value={locale}
          onChange={(event) => {
            document.cookie = `admin_locale=${event.target.value}; path=/; max-age=31536000; SameSite=Lax`;
            router.refresh();
          }}
          aria-label="Admin language"
        >
          {SUPPORTED_LOCALES.map((item) => (
            <option key={item} value={item}>{item.toUpperCase()}</option>
          ))}
        </select>
        <form className="admin-global-search" onSubmit={search}>
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={adminT(locale, "search_customers")}
            aria-label={adminT(locale, "search_customers")}
          />
        </form>
        <button type="button" className="admin-quick-action" onClick={() => router.push("/appointments?new=1")}>
          <span>{adminT(locale, "new_appointment")}</span>
          <strong aria-hidden="true">＋</strong>
        </button>
      </div>
    </header>
  );
}
