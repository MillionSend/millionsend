"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { EllipsisGlyph, MenuGlyph } from "@/components/icons/nav-icons";
import { useDismiss } from "@/components/popover-menu";
import { AppearanceRow, LanguageRow } from "@/components/sidebar";
import { authClient } from "@/lib/auth-client";
import { pickActive } from "@/lib/nav";

/** The console's own nav: five screens, static lucide-style glyphs (no hover choreography). */
export const CONSOLE_NAV = [
  { key: "overview", href: "/console" },
  { key: "regions", href: "/console/regions" },
  { key: "teams", href: "/console/teams" },
  { key: "safety", href: "/console/safety" },
  { key: "audit", href: "/console/audit" },
] as const;

export type ConsoleNavKey = (typeof CONSOLE_NAV)[number]["key"];

function ConsoleGlyph({ name }: { name: ConsoleNavKey }) {
  const paths = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </>
    ),
    regions: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      </>
    ),
    teams: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 10h18" />
        <path d="M9 10v10" />
      </>
    ),
    safety: (
      <>
        <path d="M12 2 4 5.5v6c0 5 3.4 8.6 8 10.5 4.6-1.9 8-5.5 8-10.5v-6z" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </>
    ),
    audit: (
      <>
        <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2z" />
        <path d="M14 2v6h6" />
        <path d="m9 15 2 2 4-4" />
      </>
    ),
  } as const;
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none", display: "block" }}
    >
      {paths[name]}
    </svg>
  );
}

function ConsoleSidebar({
  userEmail,
  className,
  onNavigate,
}: {
  userEmail: string;
  className?: string;
  onNavigate?: () => void;
}) {
  const t = useTranslations("console.nav");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();
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
  // /console is a prefix of every console route, so the longest match wins.
  const active = pickActive(
    pathname,
    CONSOLE_NAV.map((item) => item.href),
  );

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

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
      <div style={{ padding: "2px 10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ms-microlabel" style={{ whiteSpace: "nowrap" }}>
          {t("console")}
        </span>
        <span className="ms-chip" style={{ fontSize: 10, padding: "1px 6px", marginLeft: "auto" }}>
          /console
        </span>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegated close-drawer hook; links stay the interactive elements */}
      <nav
        className="ms-nav"
        aria-label={t("console")}
        style={{ minHeight: 0, overflowY: "auto", padding: 3, margin: "0 -3px -3px" }}
        onClick={
          onNavigate
            ? (event) => {
                if ((event.target as HTMLElement).closest("a")) onNavigate();
              }
            : undefined
        }
      >
        {CONSOLE_NAV.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className={active === item.href ? "active" : undefined}
          >
            <ConsoleGlyph name={item.key} />
            {t(item.key)}
          </Link>
        ))}
      </nav>
      <div style={{ flex: 1 }} />
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
            <AppearanceRow />
            <LanguageRow />
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
            padding: "10px 10px 2px",
            background: "none",
            border: 0,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            color: "inherit",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              background: "var(--ms-inset)",
              border: "1px solid var(--ms-line)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 600,
              flex: "none",
            }}
          >
            {userEmail.charAt(0).toUpperCase()}
          </span>
          <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 13, color: "var(--ms-bone)" }}>{t("operator")}</span>
            <span
              style={{
                fontSize: 11,
                color: "var(--ms-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {userEmail}
            </span>
          </span>
          <span style={{ marginLeft: "auto", color: "var(--ms-faint)" }}>
            <EllipsisGlyph size={13} />
          </span>
        </button>
      </div>
    </aside>
  );
}

/**
 * The console's chrome: its own sidebar (no team switcher, no link back to
 * the app) and the same off-canvas drawer treatment as the dashboard below
 * 900px, so the responsive rules in components.css apply unchanged.
 */
export function ConsoleShell({
  userEmail,
  children,
}: {
  userEmail: string;
  children: React.ReactNode;
}) {
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies(pathname): the route change is the trigger
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);
  return (
    <div className="ms-app-shell" style={{ display: "flex", minHeight: "100vh" }}>
      <header className="ms-mobile-topbar">
        <button
          type="button"
          className="ms-btn ms-btn-icon"
          aria-label={tCommon("openNav")}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <MenuGlyph size={16} />
        </button>
        {/* biome-ignore lint/performance/noImgElement: static SVG logo */}
        <img
          src="/logo/millionsend-wordmark.svg"
          className="ms-wordmark"
          alt={tCommon("appName")}
          style={{ height: 15, display: "block" }}
        />
        <span className="ms-chip" style={{ fontSize: 10, padding: "1px 6px", marginLeft: "auto" }}>
          /console
        </span>
      </header>
      {drawerOpen ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; Esc handles keyboard
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismissal is the Esc listener above
        <div className="ms-drawer-scrim" onClick={() => setDrawerOpen(false)} />
      ) : null}
      <ConsoleSidebar
        userEmail={userEmail}
        className={drawerOpen ? "ms-sidebar open" : "ms-sidebar"}
        onNavigate={() => setDrawerOpen(false)}
      />
      {children}
    </div>
  );
}
