"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AppLocale } from "@hair-simo/i18n";
import {
  dateTimeLocalToIso,
  formatSalonDate,
  formatSalonTime,
  toDateTimeLocalValue,
} from "../lib/admin-datetime";
import { AppointmentActions } from "./AppointmentActions";

type Appointment = {
  id: string;
  status: string;
  startsAt: string | Date;
  endsAt: string | Date;
  customer: { firstName: string; lastName: string; email: string | null; phone: string | null };
  service: { slug: string };
  staff: { id: string; displayName: string } | null;
  payments?: Array<{ status: string; amountCents: number }>;
};

type Service = {
  slug: string;
  priceCents: number;
  translations: Array<{ locale: string; name: string }>;
};

type Staff = { id: string; displayName: string };

export function AppointmentWorkspace({
  appointments,
  services,
  staff,
  locale,
}: {
  appointments: Appointment[];
  services: Service[];
  staff: Staff[];
  locale: AppLocale;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [showCreate, setShowCreate] = useState(params.get("new") === "1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    serviceSlug: services[0]?.slug ?? "",
    staffId: "",
    startsAt: toDateTimeLocalValue(Date.now() + 86_400_000),
    customerFirstName: "",
    customerLastName: "",
    customerEmail: "",
    customerPhone: "",
  });

  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim();
    return appointments.filter((appointment) => {
      const name = `${appointment.customer.firstName} ${appointment.customer.lastName}`.toLowerCase();
      const matchesQuery =
        !needle ||
        name.includes(needle) ||
        appointment.customer.email?.toLowerCase().includes(needle) ||
        appointment.service.slug.toLowerCase().includes(needle);
      return matchesQuery && (status === "all" || appointment.status === status);
    });
  }, [appointments, query, status]);

  async function createAppointment(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        startsAt: dateTimeLocalToIso(form.startsAt),
        staffId: form.staffId || undefined,
        locale: "de",
        sourceChannel: "web",
        termsAccepted: true,
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      setMessage(json.message ?? json.error ?? "Appointment could not be created");
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreate(false);
    router.replace("/appointments");
    router.refresh();
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Search, create, move and complete every booking from one operational view.</p>
        <button className="admin-button" type="button" onClick={() => setShowCreate(true)}>
          New appointment
        </button>
      </div>

      <div className="admin-toolbar">
        <input
          className="admin-field admin-grow"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, email or service"
        />
        <select className="admin-select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="no_show">No-show</option>
        </select>
        <span className="admin-result-count">{filtered.length} results</span>
      </div>

      <section className="admin-panel">
        <div className="admin-panel-header">
          <h2>Appointment register</h2>
          <span>Live database</span>
        </div>
        <table className="admin-data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Customer</th>
              <th>Service</th>
              <th>Team</th>
              <th>Payment</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((appointment) => (
              <tr key={appointment.id}>
                <td>
                  <strong>{formatSalonDate(appointment.startsAt, locale)}</strong>
                  <small className="admin-table-subline">
                    {formatSalonTime(appointment.startsAt, locale)}
                  </small>
                </td>
                <td>
                  {appointment.customer.firstName} {appointment.customer.lastName}
                  <small className="admin-table-subline">{appointment.customer.email ?? appointment.customer.phone ?? "No contact"}</small>
                </td>
                <td>{appointment.service.slug.replaceAll("-", " ")}</td>
                <td>{appointment.staff?.displayName ?? "Unassigned"}</td>
                <td>
                  {appointment.payments?.some((payment) => payment.status === "paid") ? (
                    <span className="admin-status sent">Paid</span>
                  ) : (
                    <span className="admin-status pending">Open</span>
                  )}
                </td>
                <td><span className={`admin-status ${appointment.status}`}>{appointment.status.replace("_", " ")}</span></td>
                <td><AppointmentActions appointment={appointment} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 ? <div className="admin-empty">No appointments match this view.</div> : null}
      </section>

      {showCreate ? (
        <div className="admin-modal-backdrop" role="presentation" onMouseDown={() => setShowCreate(false)}>
          <section className="admin-drawer" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="admin-drawer-header">
              <div>
                <span className="admin-kicker">New booking</span>
                <h2>Create appointment</h2>
              </div>
              <button type="button" onClick={() => setShowCreate(false)} aria-label="Close">×</button>
            </div>
            <form className="admin-form-grid" onSubmit={createAppointment}>
              <label>
                Service
                <select
                  className="admin-select"
                  value={form.serviceSlug}
                  onChange={(event) => setForm((current) => ({ ...current, serviceSlug: event.target.value }))}
                >
                  {services.map((service) => (
                    <option key={service.slug} value={service.slug}>
                      {service.translations.find((translation) => translation.locale === "de")?.name ?? service.slug}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Team member
                <select
                  className="admin-select"
                  value={form.staffId}
                  onChange={(event) => setForm((current) => ({ ...current, staffId: event.target.value }))}
                >
                  <option value="">First available</option>
                  {staff.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                </select>
              </label>
              <label>
                Date and time
                <input
                  className="admin-field"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))}
                  required
                />
              </label>
              <div className="admin-form-split">
                <label>
                  First name
                  <input
                    className="admin-field"
                    value={form.customerFirstName}
                    onChange={(event) => setForm((current) => ({ ...current, customerFirstName: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  Last name
                  <input
                    className="admin-field"
                    value={form.customerLastName}
                    onChange={(event) => setForm((current) => ({ ...current, customerLastName: event.target.value }))}
                    required
                  />
                </label>
              </div>
              <label>
                Email
                <input
                  className="admin-field"
                  type="email"
                  value={form.customerEmail}
                  onChange={(event) => setForm((current) => ({ ...current, customerEmail: event.target.value }))}
                  required
                />
              </label>
              <label>
                Phone
                <input
                  className="admin-field"
                  value={form.customerPhone}
                  onChange={(event) => setForm((current) => ({ ...current, customerPhone: event.target.value }))}
                />
              </label>
              {message ? <p className="admin-form-error">{message}</p> : null}
              <button className="admin-button" disabled={busy} type="submit">
                {busy ? "Creating…" : "Create appointment"}
              </button>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
