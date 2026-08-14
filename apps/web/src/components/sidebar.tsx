"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { NavGlyph, type NavIconName } from "@/components/icons/nav-icons";
import { authClient } from "@/lib/auth-client";
import { isActive } from "@/lib/nav";
import { useTRPC } from "@/lib/trpc";
import { formatUtcDayReset, meterClass } from "@/lib/usage-meter";

// Canvas nav order (Row 1 chrome): Settings lives in the main list.
export const NAV_ITEMS: ReadonlyArray<{ key: string; href: string; icon: NavIconName }> = [
  { key: "emails", href: "/emails", icon: "emails" },
  { key: "broadcasts", href: "/broadcasts", icon: "broadcasts" },
  { key: "templates", href: "/templates", icon: "templates" },
  { key: "audience", href: "/audience", icon: "audience" },
  { key: "metrics", href: "/metrics", icon: "metrics" },
  { key: "domains", href: "/domains", icon: "domains" },
  { key: "logs", href: "/logs", icon: "logs" },
  { key: "apiKeys", href: "/api-keys", icon: "api-keys" },
  { key: "webhooks", href: "/webhooks", icon: "webhooks" },
  { key: "settings", href: "/settings", icon: "settings" },
];

// Hover state lives per link so a hover repaints one glyph, not the whole nav.
function NavItem({
  item,
  active,
  label,
}: {
  item: (typeof NAV_ITEMS)[number];
  active: boolean;
  label: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Link
      href={item.href}
      className={active ? "active" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <NavGlyph name={item.icon} hovered={hovered} />
      {label}
    </Link>
  );
}

export function Sidebar({ teamName, userEmail }: { teamName: string; userEmail: string }) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const trpc = useTRPC();
  const { data: team } = useQuery(trpc.settings.team.get.queryOptions());
  const { data: usage } = useQuery(trpc.settings.usage.recent.queryOptions({}));
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  const fmt = new Intl.NumberFormat(locale);
  const today = usage?.today;
  const ratio = today?.limit ? today.accepted / today.limit : 0;
  const meterState = today && today.limit !== null ? meterClass(ratio) : "";

  return (
    <aside
      style={{
        width: 240,
        flexShrink: 0,
        background: "var(--ms-panel)",
        borderRight: "1px solid var(--ms-line)",
        position: "sticky",
        top: 0,
        height: "100vh",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px 12px",
      }}
    >
      <div style={{ padding: "4px 10px 14px" }}>
        {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
        <img src="/logo/millionsend-wordmark.svg" alt={tCommon("appName")} style={{ height: 15, display: "block" }} />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "7px 10px",
          borderRadius: 10,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "var(--ms-panel-raised)",
            border: "1px solid var(--ms-line)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 600,
            flex: "none",
          }}
        >
          {teamName.charAt(0).toUpperCase()}
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {teamName}
        </span>
        {team ? (
          <span
            style={{
              fontSize: 11,
              color: "var(--ms-muted)",
              border: "1px solid var(--ms-line)",
              borderRadius: 999,
              padding: "1px 8px",
              flex: "none",
            }}
          >
            {tCommon(`plan.${team.plan}`)}
          </span>
        ) : null}
      </div>
      <nav className="ms-nav" style={{ marginTop: 10, minHeight: 0, overflowY: "auto" }}>
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={item.key}
            item={item}
            active={isActive(pathname, item.href)}
            label={t(item.key)}
          />
        ))}
      </nav>
      <div style={{ flex: 1 }} />
      {today ? (
        <div
          className={meterState || undefined}
          style={{ padding: "12px 10px 10px", borderTop: "1px solid var(--ms-line)" }}
        >
          <div className="ms-meter-label">
            <span>{tCommon("sidebar.today")}</span>
            <span className="ms-digits" style={{ fontSize: 13, color: "var(--ms-bone)" }}>
              {fmt.format(today.accepted)}
              <span style={{ color: "var(--ms-muted)", fontWeight: 500 }}>
                {" "}
                / {today.limit === null ? "∞" : fmt.format(today.limit)}
              </span>
            </span>
          </div>
          <div className="ms-meter-track">
            <div
              className="ms-meter-fill"
              style={
                today.limit === null
                  ? { width: "100%", opacity: 0.25 }
                  : { width: `${Math.min(100, ratio * 100)}%` }
              }
            />
          </div>
          {meterState ? (
            <div style={{ fontSize: 11, color: "var(--ms-muted)", marginTop: 6 }}>
              {tCommon("sidebar.resetsIn", { time: formatUtcDayReset() })}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ position: "relative", borderTop: "1px solid var(--ms-line)" }}>
        {menuOpen ? (
          <>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: overlay click-to-dismiss; Esc handles keyboard */}
            <div
              style={{ position: "fixed", inset: 0, zIndex: 5 }}
              onMouseDown={() => setMenuOpen(false)}
            />
            <div
              className="ms-menu"
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 4,
                right: 4,
                minWidth: 0,
                zIndex: 6,
              }}
            >
              <button type="button" className="ms-menu-item" onClick={signOut}>
                {tCommon("signOut")}
              </button>
            </div>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            width: "100%",
            padding: "8px 10px 2px",
            background: "none",
            border: 0,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            color: "inherit",
          }}
        >
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: "var(--ms-panel-raised)",
              border: "1px solid var(--ms-line)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              flex: "none",
            }}
          >
            {userEmail.charAt(0)}
          </span>
          <span
            style={{
              fontSize: 12.5,
              color: "var(--ms-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {userEmail}
          </span>
          <span style={{ marginLeft: "auto", color: "var(--ms-faint)" }}>…</span>
        </button>
      </div>
    </aside>
  );
}
