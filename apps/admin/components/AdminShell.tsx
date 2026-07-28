import type { ReactNode } from "react";
import Link from "next/link";
import { Container } from "@hair-simo/ui";
import { LogoutButton } from "./LogoutButton";
import { getSession } from "../lib/auth";

const links = [
  ["dashboard", "Dashboard"],
  ["calendar", "Calendar"],
  ["appointments", "Appointments"],
  ["customers", "Customers"],
  ["services", "Services"],
  ["staff", "Staff"],
  ["rules", "Rules"],
  ["reports", "Reports"],
  ["call-logs", "Calls"],
  ["notifications", "Notifications"],
  ["products", "Products"],
] as const;

export default async function AdminShell({ children }: { children: ReactNode }) {
  const session = await getSession();

  if (!session) {
    return <>{children}</>;
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <strong>Hair Simo Admin</strong>
        <p style={{ color: "var(--hs-muted)", fontSize: "0.85rem" }}>
          {session.firstName} {session.lastName} ({session.role})
        </p>
        <nav style={{ marginTop: "1rem" }}>
          {links.map(([slug, label]) => (
            <Link key={slug} href={`/${slug}`}>
              {label}
            </Link>
          ))}
        </nav>
        <LogoutButton />
      </aside>
      <section className="admin-main">
        <Container>{children}</Container>
      </section>
    </div>
  );
}
