"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

const TABS = [
  { key: "settings", href: "/settings" },
  { key: "usage", href: "/settings/usage" },
  { key: "billing", href: "/settings/billing" },
  { key: "ses", href: "/settings/ses" },
  { key: "smtp", href: "/settings/smtp" },
  { key: "mcp", href: "/settings/mcp" },
  { key: "connectedApps", href: "/settings/connected-apps" },
  { key: "unsubscribe", href: "/settings/unsubscribe" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function SettingsTabsNav({
  showBilling,
  showSmtp,
}: {
  showBilling: boolean;
  showSmtp: boolean;
}) {
  const t = useTranslations("settings.tabs");
  const router = useRouter();
  const pathname = usePathname();
  // Unlisted keys are always shown; each page gates itself too, so a hidden
  // tab is a missing route rather than a hidden link.
  const visible: Partial<Record<TabKey, boolean>> = { billing: showBilling, smtp: showSmtp };
  return (
    <div className="ms-tabs" style={{ marginBottom: 24 }}>
      {TABS.filter((tab) => visible[tab.key] ?? true).map(({ key, href }) => (
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
