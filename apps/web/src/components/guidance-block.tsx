"use client";

import { useTranslations } from "next-intl";

/**
 * Renders resolved bounce/complaint remediation guidance: title, explanation,
 * and a concrete action. `guidanceKey` is a key prefix from the core resolver
 * (resolveBounceGuidance / resolveComplaintGuidance); the copy lives in the
 * bounce-guidance messages namespace under `.title` / `.body` / `.action`.
 */
export function GuidanceBlock({ guidanceKey }: { guidanceKey: string }) {
  const bg = useTranslations("bounce-guidance");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ms-bone)" }}>
        {bg(`${guidanceKey}.title`)}
      </div>
      <div style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.55 }}>
        {bg(`${guidanceKey}.body`)}
      </div>
      <div style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.55 }}>
        {bg(`${guidanceKey}.action`)}
      </div>
    </div>
  );
}
