"use client";

import { useState } from "react";
import { Button, Input } from "@hair-simo/ui";

type Service = {
  id: string;
  slug: string;
  durationMin: number;
  bufferAfterMin: number;
  priceCents: number;
  isActive: boolean;
};

export function ServiceEditor({ services }: { services: Service[] }) {
  const [items, setItems] = useState(services);
  const [slug, setSlug] = useState("new-service");
  const [priceCents, setPriceCents] = useState(5000);
  const [durationMin, setDurationMin] = useState(60);
  const [message, setMessage] = useState<string | null>(null);

  async function createService() {
    const response = await fetch("/api/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        category: "general",
        durationMin,
        bufferAfterMin: 10,
        priceCents,
        translations: [
          { locale: "de", name: slug, description: slug },
          { locale: "en", name: slug, description: slug },
        ],
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? "Failed");
      return;
    }
    setItems((prev) => [...prev, json.data]);
    setMessage("Service created");
  }

  async function toggleActive(id: string, isActive: boolean) {
    const response = await fetch(`/api/services/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    const json = await response.json();
    if (response.ok) {
      setItems((prev) => prev.map((item) => (item.id === id ? json.data : item)));
    }
  }

  return (
    <div className="hs-grid">
      <div className="hs-grid hs-grid-3">
        <Input label="Slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <Input label="Price (cents)" type="number" value={priceCents} onChange={(e) => setPriceCents(Number(e.target.value))} />
        <Input label="Duration (min)" type="number" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} />
      </div>
      <Button type="button" onClick={() => void createService()}>Create service</Button>
      {message ? <p>{message}</p> : null}
      {items.map((service) => (
        <div key={service.id} style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
          <span>{service.slug} · {(service.priceCents / 100).toFixed(2)} EUR</span>
          <Button type="button" variant="secondary" onClick={() => void toggleActive(service.id, service.isActive)}>
            {service.isActive ? "Deactivate" : "Activate"}
          </Button>
        </div>
      ))}
    </div>
  );
}
