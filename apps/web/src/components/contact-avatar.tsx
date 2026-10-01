"use client";

import { initials } from "@/lib/avatar";

/**
 * Contact identity mark: a letter circle (initials from the name, else the
 * email). No photo lookup: a Gravatar request would hand a hash of the
 * contact's address to a third party from every browser that shows the list.
 * Circular on purpose — teams keep the rounded-square TeamLogo tile, so the
 * two never read alike.
 */
export function ContactAvatar({
  email,
  name,
  size,
}: {
  email: string;
  name?: string | null | undefined;
  size: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "1px solid var(--ms-line)",
        background: "var(--ms-panel-raised)",
        color: "var(--ms-muted)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        flex: "none",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      {initials(name?.trim() ? name : email)}
    </span>
  );
}
