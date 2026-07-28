"use client";

import { FormEvent, useState } from "react";
import { Button, Card, Container, Input, PageHeader } from "@hair-simo/ui";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("owner@hairsimo.local");
  const [password, setPassword] = useState("HairSimo2026!");
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
      setError(json.message ?? "Login failed");
      setLoading(false);
      return;
    }
    window.location.href = "/dashboard";
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Container>
        <Card style={{ maxWidth: 420, margin: "0 auto" }}>
          <PageHeader title="Hair Simo Admin" subtitle="Sign in with your staff account" />
          <form onSubmit={onSubmit} className="hs-grid">
            <Input label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Input label="Password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            {error ? <p style={{ color: "var(--hs-danger)" }}>{error}</p> : null}
            <Button type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Card>
      </Container>
    </main>
  );
}
