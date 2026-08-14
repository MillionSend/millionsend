"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { NavGlyph, type NavIconName } from "@/components/icons/nav-icons";
import { authClient } from "@/lib/auth-client";
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

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
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
  const [hoveredNav, setHoveredNav] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
      <div style={{ padding: "4px 10px 14px", display: "flex", alignItems: "flex-end", gap: 1 }}>
        {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
        <img src="/logo/millionsend-mark.svg" alt="M" style={{ height: 15, marginBottom: 3.5 }} />
        <span className="ms-display" style={{ fontSize: 20, lineHeight: 1.15 }}>
          illionSend
        </span>
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
          <Link
            key={item.key}
            href={item.href}
            className={isActive(pathname, item.href) ? "active" : undefined}
            onMouseEnter={() => setHoveredNav(item.key)}
            onMouseLeave={() => setHoveredNav((cur) => (cur === item.key ? null : cur))}
            onFocus={() => setHoveredNav(item.key)}
            onBlur={() => setHoveredNav((cur) => (cur === item.key ? null : cur))}
          >
            <NavGlyph name={item.icon} hovered={hoveredNav === item.key} />
            {t(item.key)}
          </Link>
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
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 4,
                right: 4,
                zIndex: 6,
                background: "var(--ms-panel)",
                border: "1px solid var(--ms-line-strong)",
                borderRadius: 14,
                padding: 6,
              }}
            >
              <button
                type="button"
                onClick={signOut}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  fontSize: 13.5,
                  color: "var(--ms-bone)",
                  background: "none",
                  border: 0,
                  borderRadius: 8,
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
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
