"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppLocale } from "@hair-simo/i18n";
import { parseSalonDay, salonDayOfWeek } from "@hair-simo/core/time";
import {
  formatSalonDayNumber,
  formatSalonTime,
  formatSalonWeekday,
  salonInstantOnDay,
  salonMinutesFromMidnight,
  shiftSalonDayKey,
  toDateInputValue,
} from "../lib/admin-datetime";

type Appointment = {
  id: string;
  status: string;
  startsAt: string | Date;
  endsAt: string | Date;
  customer: { firstName: string; lastName: string };
  service: { slug: string };
  staff: { id: string; displayName: string } | null;
};

type Staff = { id: string; displayName: string };

/** Monday of the salon week containing `dayKey`, as a salon day key. */
function startOfSalonWeekKey(dayKey: string) {
  return shiftSalonDayKey(dayKey, -((salonDayOfWeek(parseSalonDay(dayKey)) + 6) % 7));
}

export function CalendarWorkspace({
  appointments,
  staff,
  locale,
}: {
  appointments: Appointment[];
  staff: Staff[];
  locale: AppLocale;
}) {
  const router = useRouter();
  const [weekOffset, setWeekOffset] = useState(0);
  const [staffId, setStaffId] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const todayKey = toDateInputValue(new Date());
  const weekStartKey = useMemo(
    () => shiftSalonDayKey(startOfSalonWeekKey(todayKey), weekOffset * 7),
    [todayKey, weekOffset],
  );
  const dayKeys = useMemo(
    () => Array.from({ length: 7 }, (_, index) => shiftSalonDayKey(weekStartKey, index)),
    [weekStartKey],
  );

  const weekStart = parseSalonDay(weekStartKey);
  const weekEnd = parseSalonDay(shiftSalonDayKey(weekStartKey, 7));
  const visible = appointments.filter((appointment) => {
    const date = new Date(appointment.startsAt);
    return date >= weekStart && date < weekEnd && (staffId === "all" || appointment.staff?.id === staffId);
  });

  async function moveAppointment(appointmentId: string, targetDayKey: string) {
    const appointment = appointments.find((item) => item.id === appointmentId);
    if (!appointment) return;
    const next = salonInstantOnDay(targetDayKey, salonMinutesFromMidnight(appointment.startsAt));
    setBusy(appointmentId);
    const response = await fetch(`/api/appointments/${appointmentId}/reschedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startsAt: next.toISOString(), reason: "calendar drag" }),
    });
    setBusy(null);
    if (response.ok) router.refresh();
  }

  return (
    <div className="admin-page">
      <div className="admin-section-header">
        <p>Drag appointments between days. Times remain unchanged and availability is checked before saving.</p>
        <div className="admin-toolbar">
          <select className="admin-select" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
            <option value="all">All team members</option>
            {staff.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
          </select>
          <button className="admin-button secondary" type="button" onClick={() => setWeekOffset((value) => value - 1)}>←</button>
          <button className="admin-button secondary" type="button" onClick={() => setWeekOffset(0)}>Today</button>
          <button className="admin-button secondary" type="button" onClick={() => setWeekOffset((value) => value + 1)}>→</button>
        </div>
      </div>

      <section className="admin-calendar">
        <div className="admin-calendar-times">
          <span />
          {Array.from({ length: 11 }, (_, index) => <span key={index}>{String(index + 8).padStart(2, "0")}:00</span>)}
        </div>
        {dayKeys.map((dayKey) => {
          const day = parseSalonDay(dayKey);
          const dayAppointments = visible.filter((appointment) => (
            toDateInputValue(appointment.startsAt) === dayKey
          ));
          const isToday = dayKey === todayKey;
          return (
            <div
              className={`admin-calendar-day ${isToday ? "today" : ""}`}
              key={dayKey}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void moveAppointment(event.dataTransfer.getData("appointmentId"), dayKey)}
            >
              <header>
                <span>{formatSalonWeekday(day, locale)}</span>
                <strong>{formatSalonDayNumber(day, locale)}</strong>
              </header>
              <div className="admin-calendar-lanes">
                {dayAppointments.map((appointment) => {
                  const start = new Date(appointment.startsAt);
                  const top = Math.max(0, (salonMinutesFromMidnight(start) - 8 * 60) / 660) * 100;
                  const duration = Math.max(30, (new Date(appointment.endsAt).getTime() - start.getTime()) / 60_000);
                  const height = Math.max(7, (duration / 660) * 100);
                  return (
                    <article
                      key={appointment.id}
                      draggable
                      onDragStart={(event) => event.dataTransfer.setData("appointmentId", appointment.id)}
                      className={`admin-calendar-event ${appointment.status} ${busy === appointment.id ? "busy" : ""}`}
                      style={{ top: `${top}%`, height: `${height}%` }}
                    >
                      <time>{formatSalonTime(start, locale)}</time>
                      <strong>{appointment.customer.firstName} {appointment.customer.lastName}</strong>
                      <small>{appointment.service.slug.replaceAll("-", " ")}</small>
                      <em>{appointment.staff?.displayName ?? "Open"}</em>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
