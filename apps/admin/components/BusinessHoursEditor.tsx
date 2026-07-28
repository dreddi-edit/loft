"use client";

import { useState } from "react";
import { Button, Input } from "@hair-simo/ui";

type Hour = {
  id: string;
  dayOfWeek: number;
  startMin: number;
  endMin: number;
  isOpen: boolean;
};

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function BusinessHoursEditor({ hours }: { hours: Hour[] }) {
  const [items, setItems] = useState(hours);
  const [message, setMessage] = useState<string | null>(null);

  async function save(entry: Hour) {
    const response = await fetch("/api/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dayOfWeek: entry.dayOfWeek,
        startMin: entry.startMin,
        endMin: entry.endMin,
        isOpen: entry.isOpen,
      }),
    });
    const json = await response.json();
    if (response.ok) {
      setItems((prev) => prev.map((item) => (item.dayOfWeek === entry.dayOfWeek ? json.data : item)));
      setMessage("Saved");
    }
  }

  return (
    <div className="hs-grid">
      {items.map((entry) => (
        <div key={entry.id} className="hs-grid hs-grid-3" style={{ alignItems: "end" }}>
          <strong>{dayNames[entry.dayOfWeek]}</strong>
          <Input
            label="Start (min)"
            type="number"
            value={entry.startMin}
            onChange={(e) =>
              setItems((prev) =>
                prev.map((item) => (item.id === entry.id ? { ...item, startMin: Number(e.target.value) } : item)),
              )
            }
          />
          <Input
            label="End (min)"
            type="number"
            value={entry.endMin}
            onChange={(e) =>
              setItems((prev) =>
                prev.map((item) => (item.id === entry.id ? { ...item, endMin: Number(e.target.value) } : item)),
              )
            }
          />
          <label>
            <input
              type="checkbox"
              checked={entry.isOpen}
              onChange={(e) =>
                setItems((prev) =>
                  prev.map((item) => (item.id === entry.id ? { ...item, isOpen: e.target.checked } : item)),
                )
              }
            />{" "}
            Open
          </label>
          <Button type="button" onClick={() => void save(entry)}>Save</Button>
        </div>
      ))}
      {message ? <p>{message}</p> : null}
    </div>
  );
}
