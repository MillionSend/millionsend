"use client";

import { useTranslations } from "next-intl";

const CENTER: React.CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  padding: 24,
  textAlign: "center",
};

// Root error boundary: rendered inside the root layout, so the intl provider
// and theme still apply. The error itself goes to the console, not the user.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("common.errorPage");
  return (
    <main style={CENTER}>
      <div
        className="ms-digits"
        style={{ fontSize: 64, fontWeight: 800, lineHeight: 1, color: "var(--ms-bone)" }}
      >
        500
      </div>
      <p style={{ margin: 0, fontSize: 14, color: "var(--ms-muted)" }}>{t("body")}</p>
      <button type="button" className="ms-btn ms-btn-secondary" onClick={reset}>
        {t("retry")}
      </button>
    </main>
  );
}
