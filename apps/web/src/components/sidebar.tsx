"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { NavIcon, type NavIconName } from "@/components/nav-icon";
import { authClient } from "@/lib/auth-client";

const NAV_ITEMS: ReadonlyArray<{ key: string; href: string; icon: NavIconName }> = [
  { key: "emails", href: "/emails", icon: "emails" },
  { key: "broadcasts", href: "/broadcasts", icon: "broadcasts" },
  { key: "audience", href: "/audience", icon: "audience" },
  { key: "metrics", href: "/metrics", icon: "metrics" },
  { key: "domains", href: "/domains", icon: "domains" },
  { key: "logs", href: "/logs", icon: "logs" },
  { key: "apiKeys", href: "/api-keys", icon: "api-keys" },
  { key: "webhooks", href: "/webhooks", icon: "webhooks" },
  { key: "templates", href: "/templates", icon: "templates" },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ teamName, userEmail }: { teamName: string; userEmail: string }) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        background: "var(--ms-panel)",
        borderRight: "1px solid var(--ms-line)",
        position: "sticky",
        top: 0,
        height: "100vh",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        padding: "20px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 12px",
          marginBottom: 24,
        }}
      >
        {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
        <img src="/logo/millionsend-mark.svg" alt={tCommon("appName")} width={22} height={22} />
        <span
          style={{
            fontWeight: 600,
            fontSize: "var(--ms-fs-ui)",
            color: "var(--ms-bone)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {teamName}
        </span>
      </div>
      <nav className="ms-nav" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className={isActive(pathname, item.href) ? "active" : undefined}
          >
            <NavIcon name={item.icon} />
            {t(item.key)}
          </Link>
        ))}
      </nav>
      <div
        style={{
          borderTop: "1px solid var(--ms-line)",
          paddingTop: 12,
          marginTop: 12,
          display: "grid",
          gap: 8,
        }}
      >
        <nav className="ms-nav">
          <Link href="/settings" className={isActive(pathname, "/settings") ? "active" : undefined}>
            <NavIcon name="settings" />
            {t("settings")}
          </Link>
        </nav>
        <span
          className="ms-mono"
          style={{
            color: "var(--ms-muted)",
            fontSize: "var(--ms-fs-label)",
            padding: "0 12px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {userEmail}
        </span>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          style={{ justifySelf: "start" }}
          onClick={signOut}
        >
          {tCommon("signOut")}
        </button>
      </div>
    </aside>
  );
}
