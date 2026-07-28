import { notFound } from "next/navigation";
import { salonRepository } from "@hair-simo/core";
import { Badge, Card, PageHeader } from "@hair-simo/ui";
import { AppointmentActions } from "../../components/AppointmentActions";
import { BusinessHoursEditor } from "../../components/BusinessHoursEditor";
import { CustomerEditor } from "../../components/CustomerEditor";
import { ServiceEditor } from "../../components/ServiceEditor";

const sections = {
  dashboard: "Dashboard",
  calendar: "Calendar",
  appointments: "Appointments",
  customers: "Customers",
  services: "Services",
  staff: "Staff",
  rules: "Business hours & rules",
  reports: "Reports",
  "call-logs": "Call logs",
  notifications: "Notifications",
  products: "Products",
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

  if (section === "appointments" || section === "calendar") {
    const appointments = await salonRepository.listAppointments();
    return (
      <div>
        <PageHeader title={sections[section]} subtitle="Manage, reschedule and cancel bookings" />
        <div className="hs-grid">
          {appointments.map((appointment) => (
            <Card key={appointment.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <div>
                  <strong>{appointment.customer.firstName} {appointment.customer.lastName}</strong>
                  <p style={{ color: "var(--hs-muted)" }}>
                    {new Date(appointment.startsAt).toLocaleString()} · {appointment.service.slug}
                    {appointment.staff ? ` · ${appointment.staff.displayName}` : ""}
                  </p>
                </div>
                <Badge>{appointment.status}</Badge>
              </div>
              <AppointmentActions appointment={appointment} />
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
        <PageHeader title="Customers" subtitle="CRM overview and notes" />
        <CustomerEditor customers={customers} />
      </div>
    );
  }

  if (section === "services") {
    const services = await salonRepository.listServices(true);
    return (
      <div>
        <PageHeader title="Services" subtitle="Catalog and pricing" />
        <ServiceEditor services={services} />
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
              <p style={{ color: "var(--hs-muted)" }}>
                Services: {member.staffServices.map((link) => link.service.slug).join(", ")}
              </p>
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
        <BusinessHoursEditor hours={hours} />
      </div>
    );
  }

  if (section === "call-logs") {
    const logs = await salonRepository.listCallLogs();
    return (
      <div>
        <PageHeader title="Call logs" subtitle="Voice interactions and fallbacks" />
        <div className="hs-grid">
          {logs.map((log) => (
            <Card key={log.id}>
              <strong>{log.actionTaken}</strong>
              <p style={{ color: "var(--hs-muted)" }}>{log.summary}</p>
              <Badge>{log.fallback ? "fallback" : "ok"}</Badge>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (section === "notifications") {
    const logs = await salonRepository.listNotificationLogs();
    return (
      <div>
        <PageHeader title="Notifications" subtitle="Delivery audit trail" />
        <div className="hs-grid">
          {logs.map((log) => (
            <Card key={log.id}>
              <strong>{log.templateKey}</strong>
              <p style={{ color: "var(--hs-muted)" }}>{log.recipient} · {log.channel}</p>
              <Badge>{log.sentAt ? "sent" : "pending"}</Badge>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (section === "products") {
    const products = await salonRepository.listProducts();
    return (
      <div>
        <PageHeader title="Products" subtitle="Retail catalog" />
        <div className="hs-grid hs-grid-2">
          {products.map((product) => (
            <Card key={product.id}>
              <strong>{product.name}</strong>
              <p style={{ color: "var(--hs-muted)" }}>{(product.priceCents / 100).toFixed(2)} EUR · stock {product.stock}</p>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const reports = await salonRepository.getReportStats();
  return (
    <div>
      <PageHeader title="Reports" subtitle="Revenue and utilization" />
      <div className="hs-grid hs-grid-2">
        <Card><strong>Revenue</strong><p>{(reports.revenueCents / 100).toFixed(2)} EUR</p></Card>
        <Card><strong>Upcoming</strong><p>{reports.upcomingAppointments}</p></Card>
        <Card><strong>Pending</strong><p>{reports.pendingAppointments}</p></Card>
        <Card><strong>Cancelled</strong><p>{reports.cancelledAppointments}</p></Card>
      </div>
    </div>
  );
}
