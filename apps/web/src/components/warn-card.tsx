import type { ReactNode } from "react";
import { statusGlow } from "@/lib/status-glow";

/** Inline warn card used inside configuration sections. */
export function WarnCard({
  children,
  action,
  flush = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  /** No space of its own above: it sits in a gap-spaced stack, such as a form grid. */
  flush?: boolean;
}) {
  return (
    <div
      role="status"
      style={{
        marginTop: flush ? 0 : 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        padding: "11px 16px",
        borderRadius: 12,
        border: "1px solid var(--ms-warn-border)",
        backgroundColor: "var(--ms-ground)",
        backgroundImage: statusGlow("warn", 14),
      }}
    >
      <span style={{ fontSize: 13, color: "var(--ms-warn)", lineHeight: 1.55, flex: "1 1 320px" }}>
        {children}
      </span>
      {/* Under the text when it does not fit beside it, right-aligned like a notice strip's action. */}
      {action ? <span style={{ flex: "none", marginLeft: "auto" }}>{action}</span> : null}
    </div>
  );
}
