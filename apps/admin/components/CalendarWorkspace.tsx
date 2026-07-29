"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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

function startOfWeek(value: Date) {
  const date = new Date(value);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function CalendarWorkspace({ appointments, staff }: { appointments: Appointment[]; staff: Staff[] }) {
  const router = useRouter();
  const [weekOffset, setWeekOffset] = useState(0);
  const [staffId, setStaffId] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const weekStart = useMemo(() => {
    const date = startOfWeek(new Date());
    date.setDate(date.getDate() + weekOffset * 7);
    return date;
  }, [weekOffset]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + index);
      return date;
    }),
    [weekStart],
  );

  const visible = appointments.filter((appointment) => {
    const date = new Date(appointment.startsAt);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return date >= weekStart && date < weekEnd && (staffId === "all" || appointment.staff?.id === staffId);
  });

  async function moveAppointment(appointmentId: string, targetDay: Date) {
    const appointment = appointments.find((item) => item.id === appointmentId);
    if (!appointment) return;
    const current = new Date(appointment.startsAt);
    const next = new Date(targetDay);
    next.setHours(current.getHours(), current.getMinutes(), 0, 0);
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
        {days.map((day) => {
          const dayAppointments = visible.filter((appointment) => (
            new Date(appointment.startsAt).toDateString() === day.toDateString()
          ));
          const isToday = day.toDateString() === new Date().toDateString();
          return (
            <div
              className={`admin-calendar-day ${isToday ? "today" : ""}`}
              key={day.toISOString()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void moveAppointment(event.dataTransfer.getData("appointmentId"), day)}
            >
              <header>
                <span>{day.toLocaleDateString("en", { weekday: "short" })}</span>
                <strong>{day.getDate()}</strong>
              </header>
              <div className="admin-calendar-lanes">
                {dayAppointments.map((appointment) => {
                  const start = new Date(appointment.startsAt);
                  const top = Math.max(0, ((start.getHours() - 8) * 60 + start.getMinutes()) / 660) * 100;
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
                      <time>{start.toLocaleTimeString("de-IT", { hour: "2-digit", minute: "2-digit" })}</time>
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
