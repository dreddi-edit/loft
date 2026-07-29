import type { ReactNode } from "react";
import { BrandLogo } from "@hair-simo/ui";
import { AdminNavigation } from "./AdminNavigation";
import { AdminTopbar } from "./AdminTopbar";
import { LogoutButton } from "./LogoutButton";
import { getSession } from "../lib/auth";
import { adminT } from "../lib/admin-messages";
import { getAdminLocale } from "../lib/admin-locale-server";

export default async function AdminShell({ children }: { children: ReactNode }) {
  const session = await getSession();
  const locale = await getAdminLocale();

  if (!session) {
    return <>{children}</>;
  }

  const firstName = session.firstName?.trim() ?? "";
  const lastName = session.lastName?.trim() ?? "";
  const email = session.email ?? "";
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || email || "Admin";
  const initials =
    `${firstName.slice(0, 1)}${lastName.slice(0, 1)}`.toUpperCase() ||
    displayName.slice(0, 1).toUpperCase();

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <BrandLogo size="md" invert />
          <span>Salon OS</span>
        </div>
        <AdminNavigation locale={locale} />
        <div className="admin-sidebar-user">
          <div>{initials}</div>
          <span>
            <strong>{displayName}</strong>
            <small>{session.role}</small>
          </span>
          <LogoutButton label={adminT(locale, "logout")} />
        </div>
      </aside>
      <section className="admin-main">
        <AdminTopbar locale={locale} />
        <main className="admin-content">{children}</main>
      </section>
    </div>
  );
}
