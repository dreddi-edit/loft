import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Hair Simo",
  description: "Hair Simo salon platform",
  openGraph: {
    title: "Hair Simo",
    description: "Multilingual salon website, booking and AI assistant.",
    type: "website",
  },
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
