"use client";

import { FormEvent, useState } from "react";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type AppLocale } from "@hair-simo/i18n";
import { BrandLogo, Button, Card, Container, Input } from "@hair-simo/ui";
import { adminT } from "../../lib/admin-messages";

function resolveAdminLocale(value?: string): AppLocale {
  if (value && (SUPPORTED_LOCALES as readonly string[]).includes(value)) return value as AppLocale;
  return DEFAULT_LOCALE;
}

export default function AdminLoginPage() {
  const locale = resolveAdminLocale(typeof document === "undefined" ? undefined : document.cookie.split("; ").find((entry) => entry.startsWith("admin_locale="))?.split("=")[1]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      const json = await response.json();
      setError(json.message ?? adminT(locale, "login_failed"));
      setLoading(false);
      return;
    }
    window.location.href = "/dashboard";
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Container>
        <Card style={{ maxWidth: 420, margin: "0 auto" }}>
          <div style={{ display: "grid", justifyItems: "center", gap: "0.75rem", marginBottom: "1.5rem" }}>
            <BrandLogo size="lg" />
            <p style={{ color: "var(--hs-muted)", margin: 0, textAlign: "center" }}>{adminT(locale, "login_subtitle")}</p>
          </div>
          <form onSubmit={onSubmit} className="hs-grid">
            <Input label={adminT(locale, "login_email")} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Input label={adminT(locale, "login_password")} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
            <Button type="submit" disabled={loading}>
              {loading ? adminT(locale, "login_submitting") : adminT(locale, "login_submit")}
            </Button>
          </form>
        </Card>
      </Container>
    </main>
  );
}
