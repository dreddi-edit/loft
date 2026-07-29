"use client";

import { useState } from "react";

type Hour = {
  id: string;
  dayOfWeek: number;
  startMin: number;
  endMin: number;
  isOpen: boolean;
};

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function minutesToTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function BusinessHoursEditor({ hours }: { hours: Hour[] }) {
  const [items, setItems] = useState(hours);
  const [message, setMessage] = useState<string | null>(null);

  async function save(entry: Hour) {
    setMessage(null);
    const response = await fetch("/api/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    const json = await response.json();
    if (response.ok) {
      setItems((current) => current.map((item) => item.dayOfWeek === entry.dayOfWeek ? json.data : item));
      setMessage(`${dayNames[entry.dayOfWeek]} saved`);
    } else {
      setMessage(json.message ?? json.error ?? "Save failed");
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Opening hours define the booking windows shared by the website, assistant and admin calendar.</p>
      </div>
      <section className="admin-hours">
        <header>
          <span>Day</span>
          <span>Open</span>
          <span>From</span>
          <span>Until</span>
          <span />
        </header>
        {items.map((entry) => (
          <div key={entry.id}>
            <strong>{dayNames[entry.dayOfWeek]}</strong>
            <label className="admin-switch">
              <input
                type="checkbox"
                checked={entry.isOpen}
                onChange={(event) => setItems((current) => current.map((item) => item.id === entry.id ? { ...item, isOpen: event.target.checked } : item))}
              />
              <span />
            </label>
            <input
              className="admin-field"
              type="time"
              disabled={!entry.isOpen}
              value={minutesToTime(entry.startMin)}
              onChange={(event) => setItems((current) => current.map((item) => item.id === entry.id ? { ...item, startMin: timeToMinutes(event.target.value) } : item))}
            />
            <input
              className="admin-field"
              type="time"
              disabled={!entry.isOpen}
              value={minutesToTime(entry.endMin)}
              onChange={(event) => setItems((current) => current.map((item) => item.id === entry.id ? { ...item, endMin: timeToMinutes(event.target.value) } : item))}
            />
            <button className="admin-button secondary" type="button" onClick={() => void save(entry)}>Save</button>
          </div>
        ))}
      </section>
      {message ? <p className="admin-inline-message">{message}</p> : null}
    </div>
  );
}
