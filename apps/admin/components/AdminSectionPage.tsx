import Link from "next/link";
import { redirect } from "next/navigation";
import { salonRepository } from "@hair-simo/core";
import { requireAdminPageSession } from "../lib/auth";
import { formatSalonTime, toDateInputValue } from "../lib/admin-datetime";
import { getAdminLocale } from "../lib/admin-locale-server";
import { AppointmentWorkspace } from "./AppointmentWorkspace";
import { AuditWorkspace } from "./AuditWorkspace";
import { BusinessHoursEditor } from "./BusinessHoursEditor";
import { CalendarWorkspace } from "./CalendarWorkspace";
import { CallLogWorkspace } from "./CallLogWorkspace";
import { CustomerEditor } from "./CustomerEditor";
import { GdprWorkspace } from "./GdprWorkspace";
import { NotificationWorkspace } from "./NotificationWorkspace";
import { ProductWorkspace } from "./ProductWorkspace";
import { RecurringWorkspace } from "./RecurringWorkspace";
import { ReportsWorkspace } from "./ReportsWorkspace";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { ServiceEditor } from "./ServiceEditor";
import { StaffWorkspace } from "./StaffWorkspace";
import { VoucherWorkspace } from "./VoucherWorkspace";
import { WaitlistWorkspace } from "./WaitlistWorkspace";

export async function AdminSectionPage({ section }: { section: string }) {
  await requireAdminPageSession();
  const locale = await getAdminLocale();

  if (section === "dashboard") {
    const [stats, appointments, products] = await Promise.all([
      salonRepository.getDashboardStats(),
      salonRepository.listAppointments(),
      salonRepository.listProducts(),
    ]);
    const todayKey = toDateInputValue(new Date());
    const todaysAppointments = appointments.filter((appointment) => toDateInputValue(appointment.startsAt) === todayKey);
    const activeToday = todaysAppointments.filter((appointment) => !["cancelled", "no_show"].includes(appointment.status));
    const occupancy = Math.min(100, Math.round((activeToday.length / 10) * 100));
    const lowStock = products.filter((product) => product.stock <= 5);

    return (
      <div className="admin-page">
        <div className="admin-section-header">
          <p>Live salon pulse. Today&apos;s schedule, commercial performance and issues that need attention.</p>
          <span className="admin-kicker">All systems operational</span>
        </div>
        <div className="admin-metric-grid">
          <div className="admin-metric"><p>Today&apos;s visits</p><strong>{activeToday.length}</strong><small>{todaysAppointments.length} total scheduled</small></div>
          <div className="admin-metric"><p>Revenue</p><strong>{(stats.revenueCents / 100).toFixed(0)} €</strong><small>Paid lifetime</small></div>
          <div className="admin-metric"><p>Occupancy</p><strong>{occupancy}%</strong><small>Target 82%</small></div>
          <div className="admin-metric"><p>No-show rate</p><strong>{stats.noShowRate}%</strong><small>Completed visits</small></div>
          <div className="admin-metric"><p>Low stock</p><strong>{lowStock.length}</strong><small>Products below 6</small></div>
        </div>
        <div className="admin-grid-dashboard">
          <section className="admin-panel">
            <div className="admin-panel-header"><h2>Today&apos;s schedule</h2><Link href="/calendar">Open calendar →</Link></div>
            <table className="admin-data-table">
              <thead><tr><th>Time</th><th>Customer</th><th>Service</th><th>Team</th><th>Status</th></tr></thead>
              <tbody>
                {todaysAppointments.map((appointment) => (
                  <tr key={appointment.id}>
                    <td>{formatSalonTime(appointment.startsAt, locale)}</td>
                    <td>{appointment.customer.firstName} {appointment.customer.lastName}</td>
                    <td>{appointment.service.slug.replaceAll("-", " ")}</td>
                    <td>{appointment.staff?.displayName ?? "Open"}</td>
                    <td><span className={`admin-status ${appointment.status}`}>{appointment.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {todaysAppointments.length === 0 ? <div className="admin-empty">No appointments scheduled for today.</div> : null}
          </section>
          <aside className="admin-dashboard-rail">
            <section>
              <div className="admin-panel-header"><h2>Attention</h2><span>{lowStock.length}</span></div>
              {lowStock.map((product) => (
                <Link href="/products" key={product.id}>
                  <span>{product.name}</span><strong>{product.stock} left</strong>
                </Link>
              ))}
              {!lowStock.length ? <div className="admin-empty">Stock levels are healthy.</div> : null}
            </section>
            <section className="admin-occupancy">
              <span className="admin-kicker">Capacity today</span>
              <strong>{occupancy}%</strong>
              <i><span style={{ width: `${occupancy}%` }} /></i>
              <p>{Math.max(0, 10 - activeToday.length)} booking slots estimated available.</p>
            </section>
          </aside>
        </div>
      </div>
    );
  }

  if (section === "calendar") {
    const [appointments, staff] = await Promise.all([
      salonRepository.listAppointments(),
      salonRepository.listStaff(),
    ]);
    return <CalendarWorkspace appointments={appointments} staff={staff} locale={locale} />;
  }

  if (section === "appointments") {
    const [appointments, services, staff] = await Promise.all([
      salonRepository.listAppointments(),
      salonRepository.listServices(true),
      salonRepository.listStaff(),
    ]);
    return <AppointmentWorkspace appointments={appointments} services={services} staff={staff} locale={locale} />;
  }

  if (section === "customers") {
    const customers = await salonRepository.listCustomers();
    return <CustomerEditor customers={customers} locale={locale} />;
  }

  if (section === "services") {
    const services = await salonRepository.listServices(true);
    return <ServiceEditor services={services} />;
  }

  if (section === "staff") {
    const [staff, services] = await Promise.all([
      salonRepository.listStaff(),
      salonRepository.listServices(true),
    ]);
    return <StaffWorkspace staff={staff} services={services} locale={locale} />;
  }

  if (section === "rules") {
    const hours = await salonRepository.listBusinessHours();
    return <BusinessHoursEditor hours={hours} locale={locale} />;
  }

  if (section === "products") {
    const products = await salonRepository.listProducts();
    return <ProductWorkspace products={products} locale={locale} />;
  }

  if (section === "reports") {
    const reports = await salonRepository.getReportStats();
    return <ReportsWorkspace initial={reports} />;
  }

  if (section === "call-logs") {
    const callLogs = await salonRepository.listCallLogs();
    return <CallLogWorkspace calls={callLogs} locale={locale} />;
  }

  if (section === "notifications") {
    const notifications = await salonRepository.listNotifications();
    return <NotificationWorkspace notifications={notifications} locale={locale} />;
  }

  if (section === "waitlist") {
    return <WaitlistWorkspace locale={locale} />;
  }

  if (section === "vouchers") {
    return <VoucherWorkspace locale={locale} />;
  }

  if (section === "gdpr") {
    return <GdprWorkspace locale={locale} />;
  }

  if (section === "audit-log") {
    return <AuditWorkspace locale={locale} />;
  }

  if (section === "reviews") {
    return <ReviewWorkspace locale={locale} />;
  }

  if (section === "recurring") {
    return <RecurringWorkspace locale={locale} />;
  }

  redirect("/dashboard");
}
