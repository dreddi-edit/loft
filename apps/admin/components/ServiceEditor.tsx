"use client";

import { FormEvent, useState } from "react";

type Translation = { locale: string; name: string; description: string };
type Service = {
  id: string;
  slug: string;
  category: string;
  durationMin: number;
  bufferAfterMin: number;
  priceCents: number;
  isActive: boolean;
  translations?: Translation[];
};

const locales = ["de", "it", "fr", "en"] as const;

function emptyTranslations(): Translation[] {
  return locales.map((locale) => ({ locale, name: "", description: "" }));
}

export function ServiceEditor({ services }: { services: Service[] }) {
  const [items, setItems] = useState(services);
  const [selectedId, setSelectedId] = useState(services[0]?.id ?? "");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    slug: "",
    category: "hair",
    durationMin: 60,
    bufferAfterMin: 10,
    priceCents: 5000,
    isActive: true,
    translations: emptyTranslations(),
  });
  const selected = items.find((service) => service.id === selectedId);

  function updateSelected(patch: Partial<Service>) {
    setItems((current) => current.map((service) => service.id === selectedId ? { ...service, ...patch } : service));
  }

  async function save(service: Service) {
    setMessage(null);
    const response = await fetch(`/api/services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: service.slug,
        category: service.category,
        durationMin: service.durationMin,
        bufferAfterMin: service.bufferAfterMin,
        priceCents: service.priceCents,
        isActive: service.isActive,
        translations: service.translations,
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? json.error ?? "Save failed");
      return;
    }
    setItems((current) => current.map((item) => item.id === service.id ? { ...item, ...json.data } : item));
    setMessage("Service saved");
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? json.error ?? "Create failed");
      return;
    }
    setItems((current) => [...current, json.data]);
    setSelectedId(json.data.id);
    setCreating(false);
    setDraft({ slug: "", category: "hair", durationMin: 60, bufferAfterMin: 10, priceCents: 5000, isActive: true, translations: emptyTranslations() });
  }

  const editor = selected ? (
    <section className="admin-record-editor">
      <header>
        <span className="admin-kicker">Service record</span>
        <h2>{selected.translations?.find((translation) => translation.locale === "de")?.name || selected.slug}</h2>
      </header>
      <div className="admin-form-split">
        <label>Slug<input className="admin-field" value={selected.slug} onChange={(event) => updateSelected({ slug: event.target.value })} /></label>
        <label>Category<input className="admin-field" value={selected.category} onChange={(event) => updateSelected({ category: event.target.value })} /></label>
        <label>Duration<input className="admin-field" type="number" value={selected.durationMin} onChange={(event) => updateSelected({ durationMin: Number(event.target.value) })} /></label>
        <label>Buffer<input className="admin-field" type="number" value={selected.bufferAfterMin} onChange={(event) => updateSelected({ bufferAfterMin: Number(event.target.value) })} /></label>
        <label>Price in cents<input className="admin-field" type="number" value={selected.priceCents} onChange={(event) => updateSelected({ priceCents: Number(event.target.value) })} /></label>
        <label className="admin-check"><input type="checkbox" checked={selected.isActive} onChange={(event) => updateSelected({ isActive: event.target.checked })} />Active and bookable</label>
      </div>
      <div className="admin-translation-grid">
        {locales.map((locale) => {
          const translations = selected.translations ?? [];
          const translation = translations.find((entry) => entry.locale === locale) ?? { locale, name: "", description: "" };
          return (
            <div key={locale}>
              <strong>{locale}</strong>
              <input className="admin-field" value={translation.name} placeholder="Name" onChange={(event) => updateSelected({ translations: [...translations.filter((entry) => entry.locale !== locale), { ...translation, name: event.target.value }] })} />
              <textarea className="admin-textarea" value={translation.description} placeholder="Description" onChange={(event) => updateSelected({ translations: [...translations.filter((entry) => entry.locale !== locale), { ...translation, description: event.target.value }] })} />
            </div>
          );
        })}
      </div>
      <button className="admin-button" type="button" onClick={() => void save(selected)}>Save service</button>
      {message ? <p className="admin-inline-message">{message}</p> : null}
    </section>
  ) : null;

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Pricing, timing, translations and visibility for every service in the booking catalog.</p>
        <button className="admin-button" type="button" onClick={() => setCreating((value) => !value)}>New service</button>
      </div>
      {creating ? (
        <form className="admin-record-editor" onSubmit={create}>
          <header><span className="admin-kicker">Catalog</span><h2>New service</h2></header>
          <div className="admin-form-split">
            <label>Slug<input className="admin-field" value={draft.slug} onChange={(event) => setDraft((value) => ({ ...value, slug: event.target.value }))} required /></label>
            <label>Category<input className="admin-field" value={draft.category} onChange={(event) => setDraft((value) => ({ ...value, category: event.target.value }))} /></label>
            <label>Duration<input className="admin-field" type="number" value={draft.durationMin} onChange={(event) => setDraft((value) => ({ ...value, durationMin: Number(event.target.value) }))} /></label>
            <label>Price in cents<input className="admin-field" type="number" value={draft.priceCents} onChange={(event) => setDraft((value) => ({ ...value, priceCents: Number(event.target.value) }))} /></label>
          </div>
          <div className="admin-translation-grid">
            {draft.translations.map((translation) => (
              <div key={translation.locale}>
                <strong>{translation.locale}</strong>
                <input className="admin-field" placeholder="Name" value={translation.name} onChange={(event) => setDraft((value) => ({ ...value, translations: value.translations.map((entry) => entry.locale === translation.locale ? { ...entry, name: event.target.value } : entry) }))} required />
                <textarea className="admin-textarea" placeholder="Description" value={translation.description} onChange={(event) => setDraft((value) => ({ ...value, translations: value.translations.map((entry) => entry.locale === translation.locale ? { ...entry, description: event.target.value } : entry) }))} />
              </div>
            ))}
          </div>
          <button className="admin-button" type="submit">Create service</button>
        </form>
      ) : null}
      <div className="admin-master-detail">
        <section className="admin-record-list">
          {items.map((service) => (
            <button key={service.id} type="button" className={selectedId === service.id ? "active" : undefined} onClick={() => setSelectedId(service.id)}>
              <span>
                <strong>{service.translations?.find((translation) => translation.locale === "de")?.name || service.slug}</strong>
                <small>{service.durationMin} min · {(service.priceCents / 100).toFixed(0)} EUR</small>
              </span>
              <span className={`admin-status ${service.isActive ? "active" : "cancelled"}`}>{service.isActive ? "Active" : "Hidden"}</span>
            </button>
          ))}
        </section>
        {editor}
      </div>
    </div>
  );
}
