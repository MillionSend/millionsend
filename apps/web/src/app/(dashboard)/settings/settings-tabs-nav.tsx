"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

const TABS = [
  { key: "settings", href: "/settings" },
  { key: "usage", href: "/settings/usage" },
  { key: "billing", href: "/settings/billing" },
  { key: "ses", href: "/settings/ses" },
  { key: "smtp", href: "/settings/smtp" },
  { key: "unsubscribe", href: "/settings/unsubscribe" },
] as const;

export function SettingsTabsNav({ showBilling }: { showBilling: boolean }) {
  const t = useTranslations("settings.tabs");
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div className="ms-tabs" style={{ marginBottom: 24 }}>
      {TABS.filter((tab) => showBilling || tab.key !== "billing").map(({ key, href }) => (
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
