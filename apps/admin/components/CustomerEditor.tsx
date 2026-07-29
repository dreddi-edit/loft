"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Customer = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  marketingOptIn: boolean;
  createdAt?: string | Date;
  notes?: Array<{ id: string; note: string; createdAt: string | Date }>;
  appointments?: Array<{ id: string; startsAt: string | Date; status: string }>;
};

export function CustomerEditor({ customers }: { customers: Customer[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [items, setItems] = useState(customers);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [selectedId, setSelectedId] = useState(customers[0]?.id ?? "");
  const [showCreate, setShowCreate] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ firstName: "", lastName: "", email: "", phone: "" });

  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim();
    if (!needle) return items;
    return items.filter((customer) =>
      `${customer.firstName} ${customer.lastName} ${customer.email ?? ""} ${customer.phone ?? ""}`.toLowerCase().includes(needle),
    );
  }, [items, query]);
  const selected = items.find((customer) => customer.id === selectedId) ?? filtered[0];

  async function save(customer: Customer) {
    const response = await fetch(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        locale: customer.locale,
        marketingOptIn: customer.marketingOptIn,
      }),
    });
    const json = await response.json();
    if (response.ok) {
      setItems((current) => current.map((item) => item.id === customer.id ? { ...item, ...json.data } : item));
      setMessage("Customer updated");
    } else {
      setMessage(json.message ?? json.error ?? "Update failed");
    }
  }

  async function addNote(customerId: string) {
    const response = await fetch(`/api/customers/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note[customerId] }),
    });
    if (response.ok) {
      setMessage("Note added");
      setNote((current) => ({ ...current, [customerId]: "" }));
      router.refresh();
    }
  }

  async function createCustomer(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...createForm, locale: "de", sourceChannel: "web", marketingOptIn: false }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? json.error ?? "Could not create customer");
      return;
    }
    setItems((current) => [json.data, ...current]);
    setSelectedId(json.data.id);
    setShowCreate(false);
    setCreateForm({ firstName: "", lastName: "", email: "", phone: "" });
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>A complete client history with contact details, visits, consent and salon notes.</p>
        <button className="admin-button" type="button" onClick={() => setShowCreate((value) => !value)}>New customer</button>
      </div>
      {showCreate ? (
        <form className="admin-inline-create" onSubmit={createCustomer}>
          <input className="admin-field" placeholder="First name" value={createForm.firstName} onChange={(event) => setCreateForm((value) => ({ ...value, firstName: event.target.value }))} required />
          <input className="admin-field" placeholder="Last name" value={createForm.lastName} onChange={(event) => setCreateForm((value) => ({ ...value, lastName: event.target.value }))} required />
          <input className="admin-field" type="email" placeholder="Email" value={createForm.email} onChange={(event) => setCreateForm((value) => ({ ...value, email: event.target.value }))} />
          <input className="admin-field" placeholder="Phone" value={createForm.phone} onChange={(event) => setCreateForm((value) => ({ ...value, phone: event.target.value }))} />
          <button className="admin-button" type="submit">Create</button>
        </form>
      ) : null}
      <div className="admin-master-detail">
        <section className="admin-customer-list">
          <div className="admin-list-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customers" />
            <span>{filtered.length}</span>
          </div>
          {filtered.map((customer) => (
            <button
              key={customer.id}
              type="button"
              className={selected?.id === customer.id ? "active" : undefined}
              onClick={() => setSelectedId(customer.id)}
            >
              <span className="admin-customer-avatar">{customer.firstName.slice(0, 1)}{customer.lastName.slice(0, 1)}</span>
              <span>
                <strong>{customer.firstName} {customer.lastName}</strong>
                <small>{customer.email ?? customer.phone ?? "No contact data"}</small>
              </span>
              <em>{customer.appointments?.length ?? 0}</em>
            </button>
          ))}
        </section>
        {selected ? (
          <section className="admin-customer-detail">
            <header>
              <span className="admin-kicker">Customer profile</span>
              <h2>{selected.firstName} {selected.lastName}</h2>
              <p>Customer since {selected.createdAt ? new Date(selected.createdAt).toLocaleDateString("en") : "—"}</p>
            </header>
            <div className="admin-form-split">
              <label>First name<input className="admin-field" value={selected.firstName} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, firstName: event.target.value } : item))} /></label>
              <label>Last name<input className="admin-field" value={selected.lastName} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, lastName: event.target.value } : item))} /></label>
              <label>Email<input className="admin-field" value={selected.email ?? ""} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, email: event.target.value } : item))} /></label>
              <label>Phone<input className="admin-field" value={selected.phone ?? ""} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, phone: event.target.value } : item))} /></label>
            </div>
            <label className="admin-check">
              <input type="checkbox" checked={selected.marketingOptIn} onChange={(event) => setItems((current) => current.map((item) => item.id === selected.id ? { ...item, marketingOptIn: event.target.checked } : item))} />
              Marketing consent
            </label>
            <button className="admin-button" type="button" onClick={() => void save(selected)}>Save profile</button>
            <div className="admin-detail-block">
              <h3>Notes</h3>
              {selected.notes?.map((entry) => (
                <div className="admin-note" key={entry.id}>
                  <p>{entry.note}</p>
                  <time>{new Date(entry.createdAt).toLocaleDateString("en")}</time>
                </div>
              ))}
              <div className="admin-note-create">
                <input className="admin-field" placeholder="Add a private salon note" value={note[selected.id] ?? ""} onChange={(event) => setNote((current) => ({ ...current, [selected.id]: event.target.value }))} />
                <button className="admin-button secondary" type="button" onClick={() => void addNote(selected.id)}>Add note</button>
              </div>
            </div>
            <div className="admin-detail-block">
              <h3>Appointment history</h3>
              {selected.appointments?.slice(0, 8).map((appointment) => (
                <div className="admin-history-row" key={appointment.id}>
                  <span>{new Date(appointment.startsAt).toLocaleDateString("en")}</span>
                  <span className={`admin-status ${appointment.status}`}>{appointment.status}</span>
                </div>
              ))}
            </div>
            {message ? <p className="admin-inline-message">{message}</p> : null}
          </section>
        ) : <div className="admin-empty">No customer selected.</div>}
      </div>
    </div>
  );
}
