"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActiveTabInView } from "@/lib/use-active-tab-in-view";
import { useTeamRole } from "@/lib/use-team-role";

const TABS = [
  { key: "settings", href: "/settings" },
  { key: "usage", href: "/settings/usage" },
  { key: "billing", href: "/settings/billing" },
  { key: "ses", href: "/settings/ses" },
  { key: "smtp", href: "/settings/smtp" },
  { key: "mcp", href: "/settings/mcp" },
  { key: "connectedApps", href: "/settings/connected-apps" },
  { key: "notifications", href: "/settings/notifications" },
  { key: "unsubscribe", href: "/settings/unsubscribe" },
  { key: "audit", href: "/settings/audit" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function SettingsTabsNav({
  showBilling,
  showSes,
  showSmtp,
}: {
  showBilling: boolean;
  showSes: boolean;
  showSmtp: boolean;
}) {
  const t = useTranslations("settings.tabs");
  const router = useRouter();
  const pathname = usePathname();
  const role = useTeamRole();
  // Unlisted keys are always shown; each page gates itself too, so a hidden
  // tab is a missing route rather than a hidden link.
  const visible: Partial<Record<TabKey, boolean>> = {
    billing: showBilling,
    ses: showSes,
    smtp: showSmtp,
    audit: role === "owner" || role === "admin",
  };
  // The audit tab joins the row only once the role is known, after the first
  // render; keying on it reveals the active tab again when it arrives.
  const tabsRef = useActiveTabInView(`${pathname} ${visible.audit}`);
  return (
    <div ref={tabsRef} className="ms-tabs bleed" style={{ marginBottom: 24 }}>
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
