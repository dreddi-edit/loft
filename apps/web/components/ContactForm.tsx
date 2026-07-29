"use client";

import { useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Input } from "@hair-simo/ui";

export function ContactForm({ locale }: { locale: AppLocale }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("loading");
    const response = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, message, locale }),
    });
    setStatus(response.ok ? "sent" : "error");
  }

  return (
    <form className="hs-contact-form" onSubmit={(event) => void onSubmit(event)}>
        <div className="hs-contact-form-heading">
          <span>02</span>
          <h2>{t(locale, "contact_title")}</h2>
        </div>
        <Input label={t(locale, "contact_name")} value={name} onChange={(e) => setName(e.target.value)} required />
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="hs-label">
          {t(locale, "contact_message")}
          <textarea className="hs-textarea" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} required />
        </label>
        <button className="hs-contact-submit" type="submit" disabled={status === "loading"}>
          {status === "loading" ? t(locale, "loading") : t(locale, "submit")}
          <span aria-hidden="true">↗</span>
        </button>
        {status === "sent" ? <p style={{ color: "var(--hs-success)" }}>{t(locale, "contact_sent")}</p> : null}
        {status === "error" ? <p style={{ color: "var(--hs-danger)" }}>{t(locale, "error_generic")}</p> : null}
    </form>
  );
}
