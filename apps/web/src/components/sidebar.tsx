"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { EllipsisGlyph, NavGlyph, type NavIconName } from "@/components/icons/nav-icons";
import { useDismiss } from "@/components/popover-menu";
import { TeamSwitcher } from "@/components/team-switcher";
import { authClient } from "@/lib/auth-client";
import { isActive } from "@/lib/nav";
import { applyTheme, currentTheme, type Theme } from "@/lib/theme";
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

/* Appearance row — label + segmented sun/moon toggle, per the account-menu
   grammar. Mounts only inside the open menu, so document is available and the
   initial state can read the live attribute. */
function AppearanceRow() {
  const tCommon = useTranslations("common");
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const pick = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  return (
    <div className="ms-menu-item static">
      {tCommon("accountMenu.appearance")}
      <span className="ms-theme-toggle">
        <button
          type="button"
          className={theme === "light" ? "active" : undefined}
          aria-label={tCommon("accountMenu.themeLight")}
          aria-pressed={theme === "light"}
          onClick={() => pick("light")}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4.4" />
            <path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" />
          </svg>
        </button>
        <button
          type="button"
          className={theme === "dark" ? "active" : undefined}
          aria-label={tCommon("accountMenu.themeDark")}
          aria-pressed={theme === "dark"}
          onClick={() => pick("dark")}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
          </svg>
        </button>
      </span>
    </div>
  );
}

export function Sidebar({
  teamName,
  teamLogoUrl,
  userEmail,
  className,
  onNavigate,
}: {
  teamName: string;
  teamLogoUrl?: string | null | undefined;
  userEmail: string;
  /** Hook for the responsive drawer treatment (see components.css .ms-sidebar). */
  className?: string;
  /** Fired when a nav link is chosen, so the mobile drawer can close. */
  onNavigate?: () => void;
}) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const trpc = useTRPC();
  const { data: usage } = useQuery(trpc.settings.usage.recent.queryOptions({}));
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useDismiss(accountRef, menuOpen, () => setMenuOpen(false));

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
      className={className}
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
        <img
          src="/logo/millionsend-wordmark.svg"
          className="ms-wordmark"
          alt={tCommon("appName")}
          style={{ height: 15, display: "block" }}
        />
      </div>
      <TeamSwitcher teamName={teamName} teamLogoUrl={teamLogoUrl} />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegated close-drawer hook; links stay the interactive elements and keyboard activation bubbles the same click */}
      <nav
        className="ms-nav"
        style={{ marginTop: 10, minHeight: 0, overflowY: "auto" }}
        onClick={
          onNavigate
            ? (event) => {
                if ((event.target as HTMLElement).closest("a")) onNavigate();
              }
            : undefined
        }
      >
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
      <div ref={accountRef} style={{ position: "relative", borderTop: "1px solid var(--ms-line)" }}>
        {menuOpen ? (
          <div
            role="menu"
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
            <Link
              href="/onboarding"
              role="menuitem"
              className="ms-menu-item"
              onClick={() => setMenuOpen(false)}
            >
              {tCommon("accountMenu.onboarding")}
            </Link>
            <AppearanceRow />
            <hr className="ms-menu-sep" />
            <button type="button" role="menuitem" className="ms-menu-item" onClick={signOut}>
              {tCommon("signOut")}
            </button>
          </div>
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
          <span style={{ marginLeft: "auto", color: "var(--ms-faint)" }}>
            <EllipsisGlyph size={13} />
          </span>
        </button>
      </div>
    </aside>
  );
}
