"use client";

import { Button } from "@hair-simo/ui";

export function LogoutButton() {
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await fetch("/api/auth/login", { method: "DELETE" });
        window.location.href = "/login";
      }}
    >
      Logout
    </Button>
  );
}
