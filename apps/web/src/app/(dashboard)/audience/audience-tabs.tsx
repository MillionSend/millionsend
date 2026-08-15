"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

const TABS = [
  { key: "audiences", href: "/audience" },
  { key: "properties", href: "/audience/properties" },
  { key: "segments", href: "/audience/segments" },
  { key: "topics", href: "/audience/topics" },
] as const;

/** Quiet section tabs for the Audience area (mirrors SettingsTabs). */
export function AudienceTabs() {
  const t = useTranslations("audience.tabs");
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
