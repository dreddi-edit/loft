"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AppLocale } from "@hair-simo/i18n";
import { adminT } from "../lib/admin-messages";

const groups = [
  {
    label: "Overview",
    links: [
      ["dashboard", "Dashboard", "01"],
      ["calendar", "Calendar", "02"],
      ["appointments", "Appointments", "03"],
    ],
  },
  {
    label: "Salon",
    links: [
      ["customers", "Customers", "04"],
      ["services", "Services", "05"],
      ["staff", "Team", "06"],
      ["rules", "Rules", "07"],
      ["products", "Products", "08"],
      ["waitlist", "Waitlist", "12"],
      ["vouchers", "Vouchers", "13"],
      ["recurring", "Recurring", "14"],
    ],
  },
  {
    label: "Insights",
    links: [
      ["reports", "Reports", "09"],
      ["call-logs", "Calls", "10"],
      ["notifications", "Notifications", "11"],
      ["reviews", "Reviews", "15"],
      ["gdpr", "GDPR", "16"],
      ["audit-log", "Audit log", "17"],
    ],
  },
] as const;

export function AdminNavigation({ locale }: { locale: AppLocale }) {
  const pathname = usePathname();

  return (
    <nav className="admin-nav" aria-label="Admin navigation">
      {groups.map((group) => (
        <div className="admin-nav-group" key={group.label}>
          <p>
            {group.label === "Overview"
              ? adminT(locale, "nav_overview")
              : group.label === "Salon"
              ? adminT(locale, "nav_salon")
              : adminT(locale, "nav_insights")}
          </p>
          {group.links.map(([slug, label, number]) => {
            const active = pathname === `/${slug}` || pathname.startsWith(`/${slug}/`);
            const translated =
              slug === "dashboard" ? adminT(locale, "dashboard") :
              slug === "calendar" ? adminT(locale, "calendar") :
              slug === "appointments" ? adminT(locale, "appointments") :
              slug === "customers" ? adminT(locale, "customers") :
              slug === "services" ? adminT(locale, "services") :
              slug === "staff" ? adminT(locale, "staff") :
              slug === "rules" ? adminT(locale, "rules") :
              slug === "products" ? adminT(locale, "products") :
              slug === "waitlist" ? "Waitlist" :
              slug === "vouchers" ? "Vouchers" :
              slug === "recurring" ? "Recurring" :
              slug === "reports" ? adminT(locale, "reports") :
              slug === "call-logs" ? adminT(locale, "call_logs") :
              slug === "notifications" ? adminT(locale, "notifications") :
              slug === "reviews" ? "Reviews" :
              slug === "gdpr" ? "GDPR" :
              slug === "audit-log" ? "Audit log" :
              label;
            return (
              <Link key={slug} href={`/${slug}`} className={active ? "active" : undefined}>
                <span>{translated}</span>
                <small>{number}</small>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
