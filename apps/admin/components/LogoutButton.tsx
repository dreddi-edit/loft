"use client";

export function LogoutButton({ label }: { label: string }) {
  return (
    <button
      className="admin-logout"
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        await fetch("/api/auth/login", { method: "DELETE" });
        window.location.href = "/login";
      }}
    >
      ↗
    </button>
  );
}
