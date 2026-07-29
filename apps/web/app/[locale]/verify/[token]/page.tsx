"use client";

import { use, useEffect, useRef, useState } from "react";
import { resolveLocale, t, type AppLocale } from "@hair-simo/i18n";
import { Card, Container } from "@hair-simo/ui";

/**
 * The landing page for the double opt-in link in the confirmation mail.
 *
 * It is a client component on purpose. Rendering it on the server would redeem the token
 * for every mail scanner and link checker that follows the URL, which is exactly what the
 * double opt-in exists to rule out. The redemption therefore happens from the browser, in
 * an effect, which no scanner runs. /api/verify/[token] carries the same guard again.
 */

type VerifyStatus = "confirmed" | "already_confirmed" | "invalid" | "cancelled" | "pending";
type VerifyState = VerifyStatus | "loading" | "error";

const VERIFY_STATUSES: readonly VerifyStatus[] = [
  "confirmed",
  "already_confirmed",
  "invalid",
  "cancelled",
  "pending",
];

type Copy = { title: string; body: string };

/**
 * The copy lives here rather than in packages/i18n so it cannot drift away from the states
 * the route can actually return; a later phase moves the keys across, exactly as
 * booking-verification-service does with the mail body.
 *
 * `invalid` covers expired and unknown links in one message because the service refuses to
 * tell them apart — see the note on VerifyStatus in the route.
 */
const COPY: Record<AppLocale, Record<VerifyStatus, Copy>> = {
  de: {
    confirmed: {
      title: "Termin bestätigt",
      body: "Danke! Ihr Termin bei Hair Simo ist bestätigt. Wir freuen uns auf Sie.",
    },
    already_confirmed: {
      title: "Bereits bestätigt",
      body: "Dieser Termin wurde schon bestätigt. Sie müssen nichts weiter tun.",
    },
    invalid: {
      title: "Link nicht mehr gültig",
      body: "Dieser Bestätigungslink ist abgelaufen oder unbekannt. Bitte fordern Sie einen neuen Link an oder rufen Sie uns an.",
    },
    cancelled: {
      title: "Termin storniert",
      body: "Dieser Termin wurde bereits storniert. Bitte buchen Sie einen neuen Termin oder rufen Sie uns an.",
    },
    pending: {
      title: "Bitte im Browser öffnen",
      body: "Öffnen Sie diesen Link direkt in Ihrem Browser, um den Termin zu bestätigen.",
    },
  },
  it: {
    confirmed: {
      title: "Appuntamento confermato",
      body: "Grazie! Il suo appuntamento da Hair Simo è confermato. La aspettiamo.",
    },
    already_confirmed: {
      title: "Già confermato",
      body: "Questo appuntamento è già stato confermato. Non deve fare altro.",
    },
    invalid: {
      title: "Link non più valido",
      body: "Questo link di conferma è scaduto o non è valido. Richieda un nuovo link oppure ci chiami.",
    },
    cancelled: {
      title: "Appuntamento annullato",
      body: "Questo appuntamento è già stato annullato. Prenoti un nuovo orario oppure ci chiami.",
    },
    pending: {
      title: "Apra il link nel browser",
      body: "Apra questo link direttamente nel suo browser per confermare l'appuntamento.",
    },
  },
  fr: {
    confirmed: {
      title: "Rendez-vous confirmé",
      body: "Merci ! Votre rendez-vous chez Hair Simo est confirmé. À très bientôt.",
    },
    already_confirmed: {
      title: "Déjà confirmé",
      body: "Ce rendez-vous a déjà été confirmé. Vous n'avez rien d'autre à faire.",
    },
    invalid: {
      title: "Lien non valable",
      body: "Ce lien de confirmation a expiré ou est inconnu. Demandez un nouveau lien ou appelez-nous.",
    },
    cancelled: {
      title: "Rendez-vous annulé",
      body: "Ce rendez-vous a déjà été annulé. Réservez un nouveau créneau ou appelez-nous.",
    },
    pending: {
      title: "Ouvrez le lien dans votre navigateur",
      body: "Ouvrez ce lien directement dans votre navigateur pour confirmer le rendez-vous.",
    },
  },
  en: {
    confirmed: {
      title: "Appointment confirmed",
      body: "Thank you! Your Hair Simo appointment is confirmed. We look forward to seeing you.",
    },
    already_confirmed: {
      title: "Already confirmed",
      body: "This appointment has already been confirmed. There is nothing else to do.",
    },
    invalid: {
      title: "Link no longer valid",
      body: "This confirmation link has expired or is unknown. Please request a new link or call the salon.",
    },
    cancelled: {
      title: "Appointment cancelled",
      body: "This appointment has already been cancelled. Please book a new time or call the salon.",
    },
    pending: {
      title: "Open the link in your browser",
      body: "Open this link directly in your browser to confirm the appointment.",
    },
  },
};

function readStatus(payload: unknown): VerifyStatus | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const status = (data as { status?: unknown }).status;
  return VERIFY_STATUSES.find((candidate) => candidate === status) ?? null;
}

export default function VerifyBookingPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: localeInput, token } = use(params);
  const locale = resolveLocale(localeInput);
  const [state, setState] = useState<VerifyState>("loading");
  // React strict mode mounts the component twice in development. Without this the second
  // run would redeem again and turn a fresh "confirmed" into "already confirmed".
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (requested.current === token) return;
    requested.current = token;

    let active = true;
    void fetch(`/api/verify/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
      .then((payload) => {
        if (!active) return;
        setState(readStatus(payload) ?? "error");
      })
      .catch(() => {
        if (active) setState("error");
      });

    return () => {
      active = false;
    };
  }, [token]);

  const copy =
    state === "loading" || state === "error"
      ? { title: t(locale, state === "loading" ? "loading" : "error_generic"), body: "" }
      : COPY[locale][state];

  return (
    <Container>
      {/* The token sits in this URL, so it must not be indexed and must not leak in Referer. */}
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <Card>
        <h1>{copy.title}</h1>
        {copy.body ? <p style={{ color: "var(--hs-muted)" }}>{copy.body}</p> : null}
      </Card>
    </Container>
  );
}
