"use client";

import { useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { t } from "@hair-simo/i18n";
import { Button } from "@hair-simo/ui";

const CONSENT_KEY = "hair-simo-cookie-consent";

export function CookieBanner({ locale }: { locale: AppLocale }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(CONSENT_KEY)) setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div className="hs-cookie-banner">
      <p>{t(locale, "cookie_text")}</p>
      <Button
        type="button"
        onClick={() => {
          localStorage.setItem(CONSENT_KEY, "accepted");
          setVisible(false);
        }}
      >
        {t(locale, "cookie_accept")}
      </Button>
    </div>
  );
}
