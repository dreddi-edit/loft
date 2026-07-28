"use client";

import { useState } from "react";
import { Button, Input } from "@hair-simo/ui";

type Customer = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  marketingOptIn: boolean;
};

export function CustomerEditor({ customers }: { customers: Customer[] }) {
  const [items, setItems] = useState(customers);
  const [note, setNote] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function save(customer: Customer) {
    const response = await fetch(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(customer),
    });
    const json = await response.json();
    if (response.ok) {
      setItems((prev) => prev.map((item) => (item.id === customer.id ? json.data : item)));
      setMessage("Customer updated");
    }
  }

  async function addNote(customerId: string) {
    const response = await fetch(`/api/customers/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note[customerId] }),
    });
    if (response.ok) setMessage("Note added");
  }

  return (
    <div className="hs-grid">
      {items.map((customer) => (
        <div key={customer.id} className="hs-grid hs-grid-2">
          <Input
            label="First name"
            value={customer.firstName}
            onChange={(e) =>
              setItems((prev) =>
                prev.map((item) => (item.id === customer.id ? { ...item, firstName: e.target.value } : item)),
              )
            }
          />
          <Input
            label="Last name"
            value={customer.lastName}
            onChange={(e) =>
              setItems((prev) =>
                prev.map((item) => (item.id === customer.id ? { ...item, lastName: e.target.value } : item)),
              )
            }
          />
          <Input
            label="Email"
            value={customer.email ?? ""}
            onChange={(e) =>
              setItems((prev) =>
                prev.map((item) => (item.id === customer.id ? { ...item, email: e.target.value } : item)),
              )
            }
          />
          <Input
            label="Phone"
            value={customer.phone ?? ""}
            onChange={(e) =>
              setItems((prev) =>
                prev.map((item) => (item.id === customer.id ? { ...item, phone: e.target.value } : item)),
              )
            }
          />
          <label>
            <input
              type="checkbox"
              checked={customer.marketingOptIn}
              onChange={(e) =>
                setItems((prev) =>
                  prev.map((item) => (item.id === customer.id ? { ...item, marketingOptIn: e.target.checked } : item)),
                )
              }
            />{" "}
            Marketing opt-in
          </label>
          <Button type="button" onClick={() => void save(customer)}>Save customer</Button>
          <Input
            label="Add note"
            value={note[customer.id] ?? ""}
            onChange={(e) => setNote((prev) => ({ ...prev, [customer.id]: e.target.value }))}
          />
          <Button type="button" variant="secondary" onClick={() => void addNote(customer.id)}>Add note</Button>
        </div>
      ))}
      {message ? <p>{message}</p> : null}
    </div>
  );
}
