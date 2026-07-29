import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AdminShell from "../components/AdminShell";
import { getAdminLocale } from "../lib/admin-locale-server";

export const metadata: Metadata = {
  title: "Hair Simo Admin",
  description: "Hair Simo administration console",
  icons: {
    icon: "/favicon.ico",
    apple: "/brand/logo-md.png",
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getAdminLocale();
  return (
    <html lang={locale}>
      <body className="hs-body">
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
