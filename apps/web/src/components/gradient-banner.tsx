import type React from "react";
import { statusGlow } from "@/lib/status-glow";

type BannerVariant = "success" | "info" | "warn" | "danger";

/** The banner action's link: bone text on a dotted muted underline. */
export const bannerLinkStyle: React.CSSProperties = {
  color: "var(--ms-bone)",
  textDecoration: "underline dotted var(--ms-muted)",
  textUnderlineOffset: 3,
};

/**
 * A status line on a soft glow: icon, a short title in the variant's color,
 * the body, and an optional action at the end. Everything aligns to the
 * first line, so a body that wraps leaves the icon, title and action beside
 * its first line instead of centered on the block.
 */
export function GradientBanner({
  variant,
  icon,
  title,
  children,
  action,
  style,
}: {
  variant: BannerVariant;
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="status"
      className="ms-wrap-row"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        fontSize: 13.5,
        lineHeight: 1.55,
        backgroundColor: "var(--ms-ground)",
        backgroundImage: statusGlow(variant, variant === "success" ? 15 : 14),
        border: `1px solid var(--ms-${variant}-border)`,
        borderRadius: 12,
        padding: "11px 16px",
        ...style,
      }}
    >
      {icon ? (
        // One text line tall, so an icon of any size centers on the first line.
        <span style={{ display: "flex", alignItems: "center", height: "1.55em", flex: "none" }}>
          {icon}
        </span>
      ) : null}
      <span style={{ color: `var(--ms-${variant})` }}>{title}</span>
      {children ? (
        <span style={{ color: "var(--ms-bone)", flex: "1 1 320px", minWidth: 0 }}>{children}</span>
      ) : null}
      {action ? <span style={{ marginLeft: "auto", flex: "none" }}>{action}</span> : null}
    </div>
  );
}
