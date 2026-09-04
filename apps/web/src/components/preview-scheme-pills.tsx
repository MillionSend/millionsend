"use client";

import { useTranslations } from "next-intl";
import type { EmailScheme } from "@/lib/email-preview";

/** Light/Dark pills for a message preview; the pressed one is the client being imitated. */
export function PreviewSchemePills({
  scheme,
  onChange,
}: {
  scheme: EmailScheme;
  onChange: (scheme: EmailScheme) => void;
}) {
  const t = useTranslations("emails");
  return (
    <span style={{ display: "flex", gap: 2 }}>
      {(["light", "dark"] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={scheme === option ? "ms-code-tab active" : "ms-code-tab"}
          aria-pressed={scheme === option}
          onClick={() => onChange(option)}
        >
          {t(option === "light" ? "detail.previewLight" : "detail.previewDark")}
        </button>
      ))}
    </span>
  );
}
