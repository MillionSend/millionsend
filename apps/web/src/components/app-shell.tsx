"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { MenuGlyph } from "@/components/icons/nav-icons";
import { Sidebar } from "@/components/sidebar";
import { ServerTeamRole } from "@/lib/use-team-role";
import type { TeamRole } from "@/server/membership";

/**
 * Shared app chrome — sidebar plus the ⌘K palette — around a page's own
 * <main>. Every signed-in-with-a-team screen must render inside this so the
 * palette is never dead on a chrome-bearing route.
 *
 * Below 900px (components.css responsive section) the sidebar becomes an
 * off-canvas drawer behind a sticky topbar; desktop layout is untouched.
 */
export function AppShell({
  teamName,
  teamLogoUrl,
  userEmail,
  receiving,
  role,
  banner,
  children,
}: {
  teamName: string;
  teamLogoUrl?: string | null | undefined;
  userEmail: string;
  /** Decided on the server so the Inboxes link is in the first paint. */
  receiving: boolean;
  /** The viewer's role in the shown team (undefined under a support view):
   * useTeamRole answers with it until the client's team list loads. */
  role: TeamRole | undefined;
  /** A strip over the whole shell, sidebar included: the support view banner. Its presence marks the shell read-only. */
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useTranslations("common");
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Any navigation closes the drawer (nav links, account menu, breadcrumbs).
  // biome-ignore lint/correctness/useExhaustiveDependencies(pathname): the route change is the trigger; the effect reads nothing from it
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    // Body scroll locks while the drawer covers the content.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  return (
    <ServerTeamRole value={role}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {banner}
        <div className="ms-app-shell" style={{ display: "flex", flex: 1 }}>
          <header className="ms-mobile-topbar">
            <button
              type="button"
              className="ms-btn ms-btn-icon"
              aria-label={t("openNav")}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <MenuGlyph size={16} />
            </button>
            <Link href="/" style={{ display: "inline-flex" }}>
              {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
              <img
                src="/logo/millionsend-wordmark.svg"
                className="ms-wordmark"
                alt={t("appName")}
                style={{ height: 15, display: "block" }}
              />
            </Link>
          </header>
          {drawerOpen ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; Esc handles keyboard
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismissal is the Esc listener above
            <div className="ms-drawer-scrim" onClick={() => setDrawerOpen(false)} />
          ) : null}
          <Sidebar
            teamName={teamName}
            teamLogoUrl={teamLogoUrl}
            userEmail={userEmail}
            receiving={receiving}
            className={drawerOpen ? "ms-sidebar open" : "ms-sidebar"}
            onNavigate={() => setDrawerOpen(false)}
          />
          <CommandPalette receiving={receiving} />
          {children}
        </div>
      </div>
    </ServerTeamRole>
  );
}
