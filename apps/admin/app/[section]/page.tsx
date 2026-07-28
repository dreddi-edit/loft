import { notFound } from "next/navigation";
import { salonRepository } from "@hair-simo/core";
import { Badge, Card, PageHeader } from "@hair-simo/ui";

const sections = {
  dashboard: "Dashboard",
  calendar: "Calendar",
  appointments: "Appointments",
  customers: "Customers",
  services: "Services",
  staff: "Staff",
  rules: "Business hours & rules",
  reports: "Reports",
} as const;

export default async function AdminSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const section = (await params).section as keyof typeof sections;
  if (!sections[section]) notFound();

  if (section === "dashboard") {
    const stats = await salonRepository.getDashboardStats();
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Operational KPIs" />
        <div className="hs-grid hs-grid-3">
          <Card><strong>Appointments</strong><p>{stats.appointments}</p></Card>
          <Card><strong>Customers</strong><p>{stats.customers}</p></Card>
          <Card><strong>Revenue</strong><p>{(stats.revenueCents / 100).toFixed(2)} EUR</p></Card>
          <Card><strong>Active services</strong><p>{stats.services}</p></Card>
          <Card><strong>No-show rate</strong><p>{stats.noShowRate}%</p></Card>
        </div>
      </div>
    );
  }

  if (section === "appointments") {
    const appointments = await salonRepository.listAppointments();
    return (
      <div>
        <PageHeader title="Appointments" subtitle="Manage, reschedule and cancel bookings" />
        <div className="hs-grid">
          {appointments.map((appointment) => (
            <Card key={appointment.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <div>
                  <strong>{appointment.customer.firstName} {appointment.customer.lastName}</strong>
                  <p style={{ color: "var(--hs-muted)" }}>
                    {new Date(appointment.startsAt).toLocaleString()} · {appointment.service.slug}
                  </p>
                </div>
                <Badge>{appointment.status}</Badge>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (section === "customers") {
    const customers = await salonRepository.listCustomers();
    return (
      <div>
        <PageHeader title="Customers" subtitle="CRM overview" />
        <div className="hs-grid hs-grid-2">
          {customers.map((customer) => (
            <Card key={customer.id}>
              <strong>{customer.firstName} {customer.lastName}</strong>
              <p style={{ color: "var(--hs-muted)" }}>{customer.email}</p>
              <Badge>{customer.locale.toUpperCase()}</Badge>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (section === "services") {
    const services = await salonRepository.listServices(true);
    return (
      <div>
        <PageHeader title="Services" subtitle="Catalog and pricing" />
        <div className="hs-grid hs-grid-2">
          {services.map((service) => (
            <Card key={service.id}>
              <strong>{service.slug}</strong>
              <p style={{ color: "var(--hs-muted)" }}>
                {(service.priceCents / 100).toFixed(2)} EUR · {service.durationMin} min
              </p>
              <Badge>{service.isActive ? "active" : "inactive"}</Badge>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (section === "staff") {
    const staff = await salonRepository.listStaff();
    return (
      <div>
        <PageHeader title="Staff" subtitle="Skills and availability" />
        <div className="hs-grid hs-grid-2">
          {staff.map((member) => (
            <Card key={member.id}>
              <strong>{member.displayName}</strong>
              <p style={{ color: "var(--hs-muted)" }}>{member.user.email}</p>
              <Badge>{member.isBookable ? "bookable" : "hidden"}</Badge>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (section === "rules") {
    const hours = await salonRepository.listBusinessHours();
    return (
      <div>
        <PageHeader title="Business hours" subtitle="Opening times and booking rules" />
        <div className="hs-grid">
          {hours.map((entry) => (
            <Card key={entry.id}>
              Day {entry.dayOfWeek}: {entry.isOpen ? `${entry.startMin}–${entry.endMin} min` : "closed"}
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (section === "calendar") {
    const appointments = await salonRepository.listAppointments();
    return (
      <div>
        <PageHeader title="Calendar" subtitle="Upcoming appointments" />
        <div className="hs-grid">
          {appointments.slice(0, 20).map((appointment) => (
            <Card key={appointment.id}>
              {new Date(appointment.startsAt).toLocaleString()} — {appointment.service.slug}
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={sections[section]} subtitle="Reporting and analytics" />
      <Card>
        <p>Revenue, utilization and no-show analytics are available via dashboard KPIs.</p>
      </Card>
    </div>
  );
}
