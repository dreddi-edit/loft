"use client";

export default function AdminError({ reset }: { reset: () => void }) {
  return (
    <section className="admin-error">
      <span className="admin-kicker">Workspace error</span>
      <h2>This view could not be loaded.</h2>
      <p>The database request or session check failed. Retry without losing your current session.</p>
      <button className="admin-button" type="button" onClick={reset}>Retry</button>
    </section>
  );
}
