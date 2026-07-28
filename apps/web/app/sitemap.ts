import type { MetadataRoute } from "next";

const locales = ["de", "it", "fr", "en"] as const;
const pages = ["", "services", "prices", "products", "team", "contact", "booking", "faq", "datenschutz", "impressum"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  return locales.flatMap((locale) =>
    pages.map((page) => ({
      url: `${baseUrl}/${locale}${page ? `/${page}` : ""}`,
      changeFrequency: "weekly",
      priority: page ? 0.7 : 1,
    })),
  );
}
