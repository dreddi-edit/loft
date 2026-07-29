import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"),
  title: "Hair Simo",
  description: "Hair Simo salon platform",
  icons: {
    icon: "/favicon.ico",
    apple: "/brand/logo-md.png",
  },
  openGraph: {
    title: "Hair Simo",
    description: "Multilingual salon website, booking and AI assistant.",
    type: "website",
    images: ["/brand/logo-lg.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="hs-body">{children}</body>
    </html>
  );
}
