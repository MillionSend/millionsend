"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

const TABS = [
  { key: "settings", href: "/settings" },
  { key: "usage", href: "/settings/usage" },
  { key: "ses", href: "/settings/ses" },
  { key: "smtp", href: "/settings/smtp" },
  { key: "unsubscribe", href: "/settings/unsubscribe" },
] as const;

export function SettingsTabs() {
  const t = useTranslations("settings.tabs");
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div className="ms-tabs" style={{ marginBottom: 24 }}>
      {TABS.map(({ key, href }) => (
        <button
          key={key}
          type="button"
          className={pathname === href ? "active" : ""}
          onClick={() => router.push(href)}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}
