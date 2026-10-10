"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { isAddressLike } from "@/lib/format";
import { Breakable } from "./breakable";
import { DotParts } from "./dot-parts";

/**
 * Page chrome: breadcrumb, display H1 with its status badges, mono meta line,
 * actions — and the tab title ("Contacts · MillionSend"). The actions sit
 * beside the title block while it keeps its natural width, and otherwise
 * take their own row under the meta line (components.css, .ms-page-row).
 */
export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
  menu,
  badges,
  leading,
  titleAdornment,
}: {
  title: string;
  /** Mono proof strip under the H1 — the resource's own numbers, " · "-separated. */
  subtitle?: string;
  /** Breadcrumb row above the H1 ("Emails / Email details"). */
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  /** The trailing icon action ("…" overflow menu, "</>" API): never alone on a row. */
  menu?: React.ReactNode;
  /** Status badges, set right after the title on its own line. */
  badges?: React.ReactNode;
  /** Identity mark beside the title block (e.g. the email's status tile). */
  leading?: React.ReactNode;
  /** A small control right after the title text (an info tooltip). */
  titleAdornment?: React.ReactNode;
}) {
  const common = useTranslations("common");
  const appName = common("appName");
  // Dashboard pages are client-rendered behind the sign-in (noindex), so the
  // H1 is the one place every screen already states its name.
  useEffect(() => {
    document.title = `${title} · ${appName}`;
  }, [title, appName]);
  return (
    <header className="ms-page-header" style={{ marginBottom: 28 }}>
      {breadcrumb ? <div className="ms-crumbs">{breadcrumb}</div> : null}
      <div className="ms-page-row" style={{ alignItems: subtitle ? "flex-end" : "center" }}>
        <div className="ms-page-title">
          {leading ? <span style={{ flex: "none", display: "inline-flex" }}>{leading}</span> : null}
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div className="ms-page-heading">
              <h1
                className={isAddressLike(title) ? "ms-display ms-data-title" : "ms-display"}
                style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", margin: 0 }}
              >
                <Breakable text={title} />
                {/* The no-break space keeps the adornment on the title's last word. */}
                {titleAdornment ? (
                  <>
                    {"\u00a0"}
                    <span style={{ display: "inline-flex", verticalAlign: "middle" }}>
                      {titleAdornment}
                    </span>
                  </>
                ) : null}
              </h1>
              {badges ? (
                <>
                  {" "}
                  <span className="ms-title-badges">{badges}</span>
                </>
              ) : null}
            </div>
            {subtitle ? (
              <div
                className="ms-mono"
                style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 8 }}
              >
                <DotParts text={subtitle} />
              </div>
            ) : null}
          </div>
        </div>
        {actions || menu ? (
          <div className="ms-page-actions">
            {actions}
            {menu ? <span className="ms-page-menu">{menu}</span> : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** A non-terminal breadcrumb segment plus its "/" separator, kept on one line together. */
export function Crumb({ href, label }: { href: string; label: string }) {
  return (
    <span className="ms-crumb-seg">
      <Link href={href} className="ms-crumb">
        {label}
      </Link>
      <span style={{ color: "var(--ms-faint)" }}>/</span>
    </span>
  );
}

/** The terminal (current-page) breadcrumb segment. */
export function CrumbEnd({ label }: { label: string }) {
  return <span className="ms-crumb-end">{label}</span>;
}
