import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hair Simo",
  description: "Hair Simo salon platform",
  openGraph: {
    title: "Hair Simo",
    description: "Multilingual salon website, booking and AI assistant.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="hs-body">{children}</body>
    </html>
  );
}
