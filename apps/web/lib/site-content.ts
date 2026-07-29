import type { AppLocale } from "@hair-simo/i18n";

export const brandAssets = {
  logo: "/brand/logo.png",
  logoMd: "/brand/logo-md.png",
  logoLg: "/brand/logo-lg.png",
  davinesLogo: "/brand/davines-logo.png",
  davinesLogoSm: "/brand/davines-logo-sm.png",
  favicon: "/favicon.ico",
} as const;

export const siteImages = {
  hero: "/images/hero.jpg",
  heroVideo: "/videos/hero-video.mp4",
  about: "/images/woman_long_hair_cut-2880w.jpg",
  gallery: [
    "/images/SaveInsta.App_449474987_18274951549234140_1534980637450241550_n-640w.jpg",
    "/images/SaveInsta.App_453865396_18278903755234140_5208830123663385795_n-640w.jpg",
    "/images/SaveInsta.App_453874148_18278793835234140_3043193392264362420_n-640w.jpg",
    "/images/SaveInsta.App_449506689_18274951525234140_37311559151397538_n-640w.jpg",
    "/images/SaveInsta.App_436300827_18264936112234140_4989174830874694435_n-640w.jpg",
    "/images/455878925_18280388740234140_1789025597635429529_n-0b1e3c09-640w.jpg",
  ],
} as const;

export type DavinesProduct = {
  slug: string;
  name: string;
  image: string;
  description: Record<AppLocale, string>;
};

export const davinesProducts: DavinesProduct[] = [
  {
    slug: "su-hair-body-wash",
    name: "SU Hair & Body Wash",
    image: "/products/su-hair-body-wash.png",
    description: {
      de: "After-Sun Dusch-Shampoo fuer Haare und Koerper. Reinigt sanft nach Sonne, Salz und Chlor.",
      it: "Doccia-shampoo doposole per capelli e corpo. Deterge delicatamente dopo sole, sale e cloro.",
      fr: "Shampooing-douche apres-soleil pour cheveux et corps. Nettoie en douceur apres soleil, sel et chlore.",
      en: "After-sun hair and body wash. Gently cleanses after sun, salt, and chlorine.",
    },
  },
  {
    slug: "su-hair-milk",
    name: "SU Hair Milk",
    image: "/products/su-hair-milk.png",
    description: {
      de: "Leave-in Spray mit UV-Schutz fuer sonnenexponiertes Haar. Sorgt fuer Geschmeidigkeit und Glanz.",
      it: "Latte spray leave-in con filtro UV per capelli esposti al sole. Dona morbidezza e lucentezza.",
      fr: "Lait spray sans rincage avec protection UV pour cheveux exposes au soleil.",
      en: "Leave-in milk with UV protection for sun-exposed hair.",
    },
  },
  {
    slug: "su-hair-mask",
    name: "SU Hair Mask",
    image: "/products/su-hair-mask.png",
    description: {
      de: "Intensivmaske fuer regenerierende Pflege nach Sonne. Naehrt trockenes und gestresstes Haar.",
      it: "Maschera nutriente e rigenerante dopo l'esposizione solare.",
      fr: "Masque nourrissant et regenerant apres exposition au soleil.",
      en: "Nourishing and repairing mask for post-sun hair care.",
    },
  },
  {
    slug: "su-protective-cream-spf-30",
    name: "SU Protective Cream SPF 30",
    image: "/products/su-protective-cream-spf-30.png",
    description: {
      de: "Koerpersonnenschutz mit hohem Schutzfaktor fuer den Sommeralltag.",
      it: "Crema protettiva corpo SPF 30 ad alta protezione.",
      fr: "Creme solaire corps SPF 30 haute protection.",
      en: "Body sunscreen with high protection SPF 30.",
    },
  },
  {
    slug: "su-protective-cream-spf-50",
    name: "SU Protective Cream SPF 50",
    image: "/products/su-protective-cream-spf-50.png",
    description: {
      de: "Sehr hoher Sonnenschutz fuer empfindliche Haut oder erste Sonnenexposition.",
      it: "Protezione molto alta SPF 50 per pelli sensibili.",
      fr: "Tres haute protection SPF 50 pour peaux sensibles.",
      en: "Very high sun protection SPF 50 for sensitive skin.",
    },
  },
  {
    slug: "su-aftersun-cream",
    name: "SU Aftersun Cream",
    image: "/products/su-aftersun-cream.png",
    description: {
      de: "Beruhigende und feuchtigkeitsspendende After-Sun Creme fuer Gesicht und Koerper.",
      it: "Crema doposole idratante e lenitiva per viso e corpo.",
      fr: "Creme apres-soleil hydratante et apaisante visage et corps.",
      en: "Hydrating and soothing aftersun cream for face and body.",
    },
  },
  {
    slug: "su-hair-body-oil",
    name: "SU Hair & Body Oil",
    image: "/products/su-hair-body-oil.png",
    description: {
      de: "Schutz- und Pflegeoel fuer Haar und Koerper mit sommerlichem Finish.",
      it: "Olio nutriente e protettivo per capelli e corpo.",
      fr: "Huile nourrissante et protectrice pour cheveux et corps.",
      en: "Protective and nourishing oil for hair and body.",
    },
  },
  {
    slug: "su-tan-maximizer",
    name: "SU Tan Maximizer",
    image: "/products/su-tan-maximizer.png",
    description: {
      de: "Pflegecreme zur Vorbereitung der Haut auf Sonnenexposition fuer ein gleichmaessiges Tanning.",
      it: "Crema preparatrice per favorire un'abbronzatura uniforme.",
      fr: "Creme preparatrice pour favoriser un bronzage uniforme.",
      en: "Prep cream that supports an even natural tan.",
    },
  },
];

export const contactInfo = {
  phone: "+39 0472 268402",
  phoneHref: "tel:+390472268402",
  email: "info@hairsimo.it",
  emailHref: "mailto:info@hairsimo.it",
  address: "Via Bastioni Maggiori, 4/c",
  city: "39042 Bressanone (BZ)",
  vat: "02922730219",
} as const;
