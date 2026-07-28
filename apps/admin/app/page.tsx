export default function AdminHomePage() {
  return (
    <main>
      <h1>Hair Simo Admin</h1>
      <p>Owner/Manager/Staff backoffice.</p>
      <ul>
        <li><a href="/dashboard">Dashboard</a></li>
        <li><a href="/calendar">Kalender</a></li>
        <li><a href="/appointments">Termine</a></li>
        <li><a href="/customers">Kunden</a></li>
        <li><a href="/services">Services</a></li>
        <li><a href="/staff">Mitarbeiter</a></li>
        <li><a href="/rules">Öffnungszeiten/Regeln</a></li>
        <li><a href="/reports">Reports</a></li>
      </ul>
    </main>
  );
}
