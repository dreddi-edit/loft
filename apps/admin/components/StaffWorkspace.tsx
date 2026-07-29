"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppLocale } from "@hair-simo/i18n";
import { dateTimeLocalToIso, formatSalonDate, salonWeekdayNames } from "../lib/admin-datetime";

type Service = { id: string; slug: string; translations?: Array<{ locale: string; name: string }> };
type Staff = {
  id: string;
  displayName: string;
  bio: string | null;
  phone: string | null;
  locale: string;
  isBookable: boolean;
  user: { email: string; firstName?: string; lastName?: string; roles?: Array<{ role: { key: string } }> };
  staffServices: Array<{ serviceId?: string; service: Service }>;
  availability?: Array<{ id: string; dayOfWeek: number; startMin: number; endMin: number }>;
  timeOffs?: Array<{ id: string; startsAt: string | Date; endsAt: string | Date; reason: string | null }>;
};

function minutesToTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function StaffWorkspace({
  staff,
  services,
  locale,
}: {
  staff: Staff[];
  services: Service[];
  locale: AppLocale;
}) {
  const router = useRouter();
  const [items, setItems] = useState(staff);
  const [selectedId, setSelectedId] = useState(staff[0]?.id ?? "");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", displayName: "", email: "", phone: "", bio: "", password: "" });
  const [timeOff, setTimeOff] = useState({ startsAt: "", endsAt: "", reason: "" });
  const selected = items.find((member) => member.id === selectedId);
  const dayNames = salonWeekdayNames(locale, "short");

  function update(patch: Partial<Staff>) {
    setItems((current) => current.map((member) => member.id === selectedId ? { ...member, ...patch } : member));
  }

  async function save(member: Staff) {
    const [profileResponse, servicesResponse] = await Promise.all([
      fetch(`/api/staff/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: member.displayName,
          bio: member.bio,
          phone: member.phone,
          locale: member.locale,
          isBookable: member.isBookable,
          role: member.user.roles?.[0]?.role.key ?? "staff",
        }),
      }),
      fetch(`/api/staff/${member.id}/services`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceIds: member.staffServices.map((entry) => entry.service.id) }),
      }),
    ]);
    const json = await profileResponse.json();
    setMessage(profileResponse.ok && servicesResponse.ok ? "Team member saved" : json.message ?? json.error ?? "Save failed");
    if (profileResponse.ok && servicesResponse.ok) router.refresh();
  }

  async function saveAvailability() {
    if (!selected) return;
    const response = await fetch(`/api/staff/${selected.id}/availability`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rules: (selected.availability ?? []).map(({ dayOfWeek, startMin, endMin }) => ({ dayOfWeek, startMin, endMin })),
      }),
    });
    const json = await response.json();
    setMessage(response.ok ? "Weekly schedule saved" : json.message ?? json.error ?? "Schedule save failed");
    if (response.ok) router.refresh();
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, locale: "de", isBookable: true, role: "staff" }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? json.error ?? "Create failed");
      return;
    }
    setItems((current) => [...current, json.data]);
    setSelectedId(json.data.id);
    setCreating(false);
    router.refresh();
  }

  async function addTimeOff(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const response = await fetch(`/api/staff/${selected.id}/time-off`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...timeOff,
        startsAt: dateTimeLocalToIso(timeOff.startsAt),
        endsAt: dateTimeLocalToIso(timeOff.endsAt),
      }),
    });
    const json = await response.json();
    setMessage(response.ok ? "Time off added" : json.message ?? json.error ?? "Could not add time off");
    if (response.ok) router.refresh();
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Profiles, booking visibility, assigned services and planned absences for the salon team.</p>
        <button className="admin-button" type="button" onClick={() => setCreating((value) => !value)}>Add team member</button>
      </div>
      {creating ? (
        <form className="admin-inline-create" onSubmit={create}>
          <input className="admin-field" placeholder="First name" value={form.firstName} onChange={(event) => setForm((value) => ({ ...value, firstName: event.target.value }))} required />
          <input className="admin-field" placeholder="Last name" value={form.lastName} onChange={(event) => setForm((value) => ({ ...value, lastName: event.target.value }))} required />
          <input className="admin-field" placeholder="Display name" value={form.displayName} onChange={(event) => setForm((value) => ({ ...value, displayName: event.target.value }))} required />
          <input className="admin-field" type="email" placeholder="Email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required />
          <input className="admin-field" placeholder="Phone" value={form.phone} onChange={(event) => setForm((value) => ({ ...value, phone: event.target.value }))} />
          <input className="admin-field" type="password" placeholder="Temporary password" value={form.password} onChange={(event) => setForm((value) => ({ ...value, password: event.target.value }))} required />
          <button className="admin-button" type="submit">Create</button>
        </form>
      ) : null}
      <div className="admin-master-detail">
        <section className="admin-record-list">
          {items.map((member) => (
            <button key={member.id} type="button" className={member.id === selectedId ? "active" : undefined} onClick={() => setSelectedId(member.id)}>
              <span>
                <strong>{member.displayName}</strong>
                <small>{member.user.email}</small>
              </span>
              <span className={`admin-status ${member.isBookable ? "active" : "cancelled"}`}>{member.isBookable ? "Bookable" : "Hidden"}</span>
            </button>
          ))}
        </section>
        {selected ? (
          <section className="admin-record-editor">
            <header><span className="admin-kicker">Team profile</span><h2>{selected.displayName}</h2></header>
            <div className="admin-form-split">
              <label>Display name<input className="admin-field" value={selected.displayName} onChange={(event) => update({ displayName: event.target.value })} /></label>
              <label>Phone<input className="admin-field" value={selected.phone ?? ""} onChange={(event) => update({ phone: event.target.value })} /></label>
              <label>
                Role
                <select
                  className="admin-select"
                  value={selected.user.roles?.[0]?.role.key ?? "staff"}
                  onChange={(event) => update({ user: { ...selected.user, roles: [{ role: { key: event.target.value } }] } })}
                >
                  <option value="owner">Owner</option>
                  <option value="manager">Manager</option>
                  <option value="staff">Staff</option>
                </select>
              </label>
            </div>
            <label>Bio<textarea className="admin-textarea" value={selected.bio ?? ""} onChange={(event) => update({ bio: event.target.value })} /></label>
            <label className="admin-check"><input type="checkbox" checked={selected.isBookable} onChange={(event) => update({ isBookable: event.target.checked })} />Visible in booking</label>
            <div className="admin-detail-block">
              <h3>Services</h3>
              <div className="admin-check-grid">
                {services.map((service) => {
                  const checked = selected.staffServices.some((entry) => entry.service.id === service.id);
                  return (
                    <label className="admin-check" key={service.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => update({
                          staffServices: event.target.checked
                            ? [...selected.staffServices, { service }]
                            : selected.staffServices.filter((entry) => entry.service.id !== service.id),
                        })}
                      />
                      {service.translations?.find((translation) => translation.locale === "de")?.name ?? service.slug}
                    </label>
                  );
                })}
              </div>
            </div>
            <button className="admin-button" type="button" onClick={() => void save(selected)}>Save profile</button>
            <div className="admin-detail-block">
              <h3>Weekly schedule</h3>
              <div className="admin-availability">
                {selected.availability?.map((entry) => (
                  <div key={entry.id}>
                    <strong>{dayNames[entry.dayOfWeek]}</strong>
                    <input
                      className="admin-field"
                      type="time"
                      value={minutesToTime(entry.startMin)}
                      onChange={(event) => update({ availability: selected.availability?.map((item) => item.id === entry.id ? { ...item, startMin: timeToMinutes(event.target.value) } : item) })}
                    />
                    <input
                      className="admin-field"
                      type="time"
                      value={minutesToTime(entry.endMin)}
                      onChange={(event) => update({ availability: selected.availability?.map((item) => item.id === entry.id ? { ...item, endMin: timeToMinutes(event.target.value) } : item) })}
                    />
                  </div>
                ))}
              </div>
              <button className="admin-button secondary" type="button" onClick={() => void saveAvailability()}>Save schedule</button>
            </div>
            <div className="admin-detail-block">
              <h3>Time off</h3>
              {selected.timeOffs?.map((entry) => (
                <div className="admin-history-row" key={entry.id}>
                  <span>{formatSalonDate(entry.startsAt, locale)} — {formatSalonDate(entry.endsAt, locale)}</span>
                  <small>{entry.reason ?? "Time off"}</small>
                </div>
              ))}
              <form className="admin-timeoff-form" onSubmit={addTimeOff}>
                <input className="admin-field" type="datetime-local" value={timeOff.startsAt} onChange={(event) => setTimeOff((value) => ({ ...value, startsAt: event.target.value }))} required />
                <input className="admin-field" type="datetime-local" value={timeOff.endsAt} onChange={(event) => setTimeOff((value) => ({ ...value, endsAt: event.target.value }))} required />
                <input className="admin-field" placeholder="Reason" value={timeOff.reason} onChange={(event) => setTimeOff((value) => ({ ...value, reason: event.target.value }))} />
                <button className="admin-button secondary" type="submit">Add</button>
              </form>
            </div>
            {message ? <p className="admin-inline-message">{message}</p> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
