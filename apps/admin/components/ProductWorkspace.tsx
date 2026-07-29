"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Movement = { id: string; delta: number; reason: string | null; createdAt: string | Date };
type Product = {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
  inventoryMovements?: Movement[];
};

export function ProductWorkspace({ products }: { products: Product[] }) {
  const router = useRouter();
  const [items, setItems] = useState(products);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(products[0]?.id ?? "");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState({ delta: 0, reason: "" });
  const [form, setForm] = useState({ sku: "", name: "", priceCents: 0, stock: 0 });
  const visible = useMemo(
    () => items.filter((product) => `${product.name} ${product.sku}`.toLowerCase().includes(query.toLowerCase())),
    [items, query],
  );
  const selected = items.find((product) => product.id === selectedId);

  function update(patch: Partial<Product>) {
    setItems((current) => current.map((product) => product.id === selectedId ? { ...product, ...patch } : product));
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? json.error ?? "Create failed");
      return;
    }
    setItems((current) => [...current, json.data]);
    setSelectedId(json.data.id);
    setCreating(false);
  }

  async function save(product: Product) {
    const response = await fetch(`/api/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: product.sku, name: product.name, priceCents: product.priceCents }),
    });
    const json = await response.json();
    setMessage(response.ok ? "Product saved" : json.message ?? json.error ?? "Save failed");
  }

  async function adjustStock(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const response = await fetch(`/api/products/${selected.id}/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: adjustment.delta, type: "adjustment", reason: adjustment.reason }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? json.error ?? "Adjustment failed");
      return;
    }
    setItems((current) => current.map((product) => product.id === selected.id ? {
      ...product,
      ...json.data.product,
      inventoryMovements: [json.data.movement, ...(product.inventoryMovements ?? [])],
    } : product));
    setAdjustment({ delta: 0, reason: "" });
    setMessage("Stock adjusted");
    router.refresh();
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Retail catalog and traceable stock movements. Low stock is highlighted automatically.</p>
        <button className="admin-button" type="button" onClick={() => setCreating((value) => !value)}>New product</button>
      </div>
      {creating ? (
        <form className="admin-inline-create" onSubmit={create}>
          <input className="admin-field" placeholder="SKU" value={form.sku} onChange={(event) => setForm((value) => ({ ...value, sku: event.target.value }))} required />
          <input className="admin-field" placeholder="Product name" value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} required />
          <input className="admin-field" type="number" placeholder="Price cents" value={form.priceCents} onChange={(event) => setForm((value) => ({ ...value, priceCents: Number(event.target.value) }))} required />
          <input className="admin-field" type="number" placeholder="Opening stock" value={form.stock} onChange={(event) => setForm((value) => ({ ...value, stock: Number(event.target.value) }))} />
          <button className="admin-button" type="submit">Create</button>
        </form>
      ) : null}
      <input className="admin-field" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search product or SKU" />
      <div className="admin-master-detail">
        <section className="admin-record-list">
          {visible.map((product) => (
            <button key={product.id} type="button" className={product.id === selectedId ? "active" : undefined} onClick={() => setSelectedId(product.id)}>
              <span><strong>{product.name}</strong><small>{product.sku} · {(product.priceCents / 100).toFixed(2)} EUR</small></span>
              <span className={`admin-stock ${product.stock <= 5 ? "low" : ""}`}>{product.stock}</span>
            </button>
          ))}
        </section>
        {selected ? (
          <section className="admin-record-editor">
            <header><span className="admin-kicker">Retail product</span><h2>{selected.name}</h2></header>
            <div className="admin-form-split">
              <label>SKU<input className="admin-field" value={selected.sku} onChange={(event) => update({ sku: event.target.value })} /></label>
              <label>Name<input className="admin-field" value={selected.name} onChange={(event) => update({ name: event.target.value })} /></label>
              <label>Price in cents<input className="admin-field" type="number" value={selected.priceCents} onChange={(event) => update({ priceCents: Number(event.target.value) })} /></label>
              <label>Current stock<input className="admin-field" value={selected.stock} readOnly /></label>
            </div>
            <button className="admin-button" type="button" onClick={() => void save(selected)}>Save product</button>
            <div className="admin-detail-block">
              <h3>Adjust stock</h3>
              <form className="admin-note-create" onSubmit={adjustStock}>
                <input className="admin-field" type="number" value={adjustment.delta} onChange={(event) => setAdjustment((value) => ({ ...value, delta: Number(event.target.value) }))} required />
                <input className="admin-field" placeholder="Reason" value={adjustment.reason} onChange={(event) => setAdjustment((value) => ({ ...value, reason: event.target.value }))} required />
                <button className="admin-button secondary" type="submit">Apply</button>
              </form>
            </div>
            <div className="admin-detail-block">
              <h3>Movement history</h3>
              {selected.inventoryMovements?.map((movement) => (
                <div className="admin-history-row" key={movement.id}>
                  <strong className={movement.delta < 0 ? "admin-negative" : "admin-positive"}>{movement.delta > 0 ? "+" : ""}{movement.delta}</strong>
                  <span>{movement.reason ?? "Stock adjustment"}</span>
                  <small>{new Date(movement.createdAt).toLocaleDateString("en")}</small>
                </div>
              ))}
            </div>
            {message ? <p className="admin-inline-message">{message}</p> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
