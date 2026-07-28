import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AdminShell from "../components/AdminShell";

export const metadata: Metadata = {
  title: "Hair Simo Admin",
  description: "Hair Simo administration console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="hs-body">
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
