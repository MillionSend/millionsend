import { useTranslations } from "next-intl";

/** Centered card on the void with the wordmark above — login/signup/onboarding frame. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
      <img
        src="/logo/millionsend-wordmark.svg"
        className="ms-wordmark"
        alt={t("appName")}
        height={22}
        style={{ marginBottom: 28 }}
      />
      <div className="ms-card" style={{ width: 380, maxWidth: "100%", padding: 28 }}>
        {children}
      </div>
    </main>
  );
}
