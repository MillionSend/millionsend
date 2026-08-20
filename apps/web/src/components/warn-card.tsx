import type { ReactNode } from "react";
import { statusGlow } from "@/lib/status-glow";

/** Inline warn card used inside configuration sections. */
export function WarnCard({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        marginTop: 14,
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
      {action ? <span style={{ flex: "none" }}>{action}</span> : null}
    </div>
  );
}
