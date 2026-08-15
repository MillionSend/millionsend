"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { pickActive } from "@/lib/nav";

const TABS = [
  { key: "contacts", href: "/audience" },
  { key: "properties", href: "/audience/properties" },
  { key: "segments", href: "/audience/segments" },
  { key: "topics", href: "/audience/topics" },
] as const;

/** Quiet section tabs for the Audience area (mirrors SettingsTabs). */
export function AudienceTabs() {
  const t = useTranslations("audience.tabs");
  const router = useRouter();
  const pathname = usePathname();
  // Longest matching prefix wins, so /audience/[id]* highlights Contacts while
  // /audience/segments (also under /audience) highlights Segments — a plain
  // prefix match on the Contacts href alone would light up on every sibling.
  const activeHref = pickActive(
    pathname,
    TABS.map((tab) => tab.href),
  );
  return (
    <div className="ms-tabs" style={{ marginBottom: 24 }}>
      {TABS.map(({ key, href }) => (
        <button
          key={key}
          type="button"
          className={href === activeHref ? "active" : ""}
          onClick={() => router.push(href)}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}
