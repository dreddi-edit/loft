import type { AppLocale } from "@hair-simo/i18n";

type LegalSection = {
  heading: string;
  paragraphs: string[];
};

type LegalContent = {
  privacy: LegalSection[];
  imprint: LegalSection[];
};

export const legalContent: Record<AppLocale, LegalContent> = {
  de: {
    privacy: [
      {
        heading: "Verantwortliche Stelle",
        paragraphs: [
          "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italien.",
          "E-Mail: info@hairsimo.it · Telefon: +39 0472 268402 · P.IVA: 02922730219.",
        ],
      },
      {
        heading: "Welche Daten wir verarbeiten",
        paragraphs: [
          "Bei Terminbuchungen und Kontaktanfragen verarbeiten wir insbesondere Name, Kontaktinformationen, Terminwunsch und Mitteilungen.",
          "Diese Angaben entsprechen den Kontakt- und Buchungsformularen der bisherigen Website und werden nur zweckgebunden verarbeitet.",
        ],
      },
      {
        heading: "Zwecke und Rechtsgrundlagen",
        paragraphs: [
          "Die Verarbeitung erfolgt zur Bearbeitung von Anfragen, Durchführung von Terminen sowie für die Kundenkommunikation.",
          "Rechtsgrundlagen sind Art. 6 Abs. 1 lit. b DSGVO (Vertrag/Anbahnung), Art. 6 Abs. 1 lit. c DSGVO (gesetzliche Pflichten) und Art. 6 Abs. 1 lit. a DSGVO (Einwilligung).",
        ],
      },
      {
        heading: "Einwilligungen aus den Formularen",
        paragraphs: [
          "Mit dem Absenden bestätigen Sie: \"Ich habe die Informationen gelesen und erlaube die Verarbeitung meiner personenbezogenen Daten für die dort angegebenen Zwecke.\"",
          "Optional können Sie Marketing-Einwilligungen erteilen (z. B. Sonderangebote und Aktionen). Diese Einwilligung ist freiwillig und jederzeit widerrufbar.",
        ],
      },
      {
        heading: "Cookies und Einwilligungsverwaltung",
        paragraphs: [
          "Die bisherige Website nutzte Cookiebot (CBID a854b7ba-7720-4bde-a5a6-f8250877a176) zur Einwilligungssteuerung.",
          "In der aktuellen Website werden nur technisch notwendige Funktionen und eine lokale Einwilligungsinformation für das Banner verwendet.",
        ],
      },
      {
        heading: "Speicherdauer und Ihre Rechte",
        paragraphs: [
          "Daten werden nur so lange gespeichert, wie es für den jeweiligen Zweck oder aufgrund gesetzlicher Aufbewahrungspflichten erforderlich ist.",
          "Sie haben jederzeit das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Widerspruch und Datenübertragbarkeit sowie das Recht auf Beschwerde bei einer Aufsichtsbehörde.",
        ],
      },
    ],
    imprint: [
      {
        heading: "Angaben gemäß Anbieterkennzeichnung",
        paragraphs: [
          "Hair Simo",
          "Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italien",
          "Telefon: +39 0472 268402",
          "E-Mail: info@hairsimo.it",
          "P.IVA: 02922730219",
        ],
      },
      {
        heading: "Hinweis",
        paragraphs: [
          "Diese Angaben basieren auf den Unternehmensinformationen der bisherigen Website und wurden für die neue Plattform konsolidiert.",
        ],
      },
    ],
  },
  it: {
    privacy: [
      {
        heading: "Titolare del trattamento",
        paragraphs: [
          "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italia.",
          "E-mail: info@hairsimo.it · Telefono: +39 0472 268402 · P.IVA: 02922730219.",
        ],
      },
      {
        heading: "Dati trattati",
        paragraphs: [
          "Per prenotazioni e richieste di contatto trattiamo nome, contatti, dettagli appuntamento e messaggi.",
          "I dati corrispondono ai moduli presenti nel sito precedente e sono trattati solo per finalità pertinenti.",
        ],
      },
      {
        heading: "Finalità e basi giuridiche",
        paragraphs: [
          "Il trattamento serve alla gestione delle richieste, delle prenotazioni e della comunicazione con i clienti.",
          "Basi giuridiche: art. 6(1)(b) GDPR (contratto/precontrattuale), art. 6(1)(c) GDPR (obblighi legali), art. 6(1)(a) GDPR (consenso).",
        ],
      },
      {
        heading: "Consensi dei moduli",
        paragraphs: [
          "Con l'invio confermi: \"Ho letto l'informativa e autorizzo il trattamento dei miei dati personali per le finalità ivi indicate.\"",
          "Il consenso marketing (offerte/promozioni) è facoltativo e revocabile in qualsiasi momento.",
        ],
      },
      {
        heading: "Cookie",
        paragraphs: [
          "Il sito precedente utilizzava Cookiebot (CBID a854b7ba-7720-4bde-a5a6-f8250877a176) per la gestione dei consensi.",
          "Nel sito attuale vengono usate funzioni tecniche essenziali e una preferenza locale per il banner cookie.",
        ],
      },
      {
        heading: "Conservazione e diritti",
        paragraphs: [
          "I dati sono conservati solo per il tempo necessario alle finalità dichiarate o agli obblighi di legge.",
          "Puoi esercitare i diritti di accesso, rettifica, cancellazione, limitazione, opposizione, portabilità e reclamo all'autorità competente.",
        ],
      },
    ],
    imprint: [
      {
        heading: "Dati aziendali",
        paragraphs: [
          "Hair Simo",
          "Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italia",
          "Telefono: +39 0472 268402",
          "E-mail: info@hairsimo.it",
          "P.IVA: 02922730219",
        ],
      },
    ],
  },
  fr: {
    privacy: [
      {
        heading: "Responsable du traitement",
        paragraphs: [
          "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italie.",
          "E-mail: info@hairsimo.it · Téléphone: +39 0472 268402 · P.IVA: 02922730219.",
        ],
      },
      {
        heading: "Données traitées",
        paragraphs: [
          "Pour les réservations et prises de contact, nous traitons notamment l'identité, les coordonnées, les détails de rendez-vous et les messages.",
          "Ces informations proviennent des formulaires du site précédent et sont traitées uniquement pour des finalités déterminées.",
        ],
      },
      {
        heading: "Finalités et base légale",
        paragraphs: [
          "Traitement pour répondre aux demandes, gérer les rendez-vous et assurer la communication client.",
          "Base légale: art. 6(1)(b), 6(1)(c) et 6(1)(a) RGPD.",
        ],
      },
      {
        heading: "Cookies et consentement",
        paragraphs: [
          "L'ancien site utilisait Cookiebot (CBID a854b7ba-7720-4bde-a5a6-f8250877a176).",
          "Le site actuel utilise des fonctions techniques essentielles et un état de consentement local pour la bannière.",
        ],
      },
    ],
    imprint: [
      {
        heading: "Mentions légales",
        paragraphs: [
          "Hair Simo",
          "Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italie",
          "Téléphone: +39 0472 268402",
          "E-mail: info@hairsimo.it",
          "P.IVA: 02922730219",
        ],
      },
    ],
  },
  en: {
    privacy: [
      {
        heading: "Data Controller",
        paragraphs: [
          "Hair Simo, Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italy.",
          "Email: info@hairsimo.it · Phone: +39 0472 268402 · VAT (P.IVA): 02922730219.",
        ],
      },
      {
        heading: "Data We Process",
        paragraphs: [
          "For booking and contact requests, we process identity data, contact details, appointment preferences and message content.",
          "These fields reflect the old website forms and are processed only for relevant business purposes.",
        ],
      },
      {
        heading: "Purposes and Legal Bases",
        paragraphs: [
          "Processing is used to respond to enquiries, manage appointments and provide customer communication.",
          "Legal bases: GDPR Art. 6(1)(b), 6(1)(c) and 6(1)(a).",
        ],
      },
      {
        heading: "Cookie and Consent Handling",
        paragraphs: [
          "The previous website used Cookiebot (CBID a854b7ba-7720-4bde-a5a6-f8250877a176) for consent management.",
          "The current website uses essential technical functionality and a local consent state for the cookie banner.",
        ],
      },
    ],
    imprint: [
      {
        heading: "Legal Notice",
        paragraphs: [
          "Hair Simo",
          "Via Bastioni Maggiori 4/c, 39042 Bressanone (BZ), Italy",
          "Phone: +39 0472 268402",
          "Email: info@hairsimo.it",
          "VAT (P.IVA): 02922730219",
        ],
      },
    ],
  },
};
