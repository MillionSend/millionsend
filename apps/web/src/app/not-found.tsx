import { getTranslations } from "next-intl/server";

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

export default async function NotFound() {
  const t = await getTranslations("common.notFound");
  return (
    <main style={CENTER}>
      <div
        className="ms-digits"
        style={{ fontSize: 64, fontWeight: 800, lineHeight: 1, color: "var(--ms-bone)" }}
      >
        404
      </div>
      <p style={{ margin: 0, fontSize: 14, color: "var(--ms-muted)" }}>{t("body")}</p>
      <a className="ms-btn ms-btn-secondary" href="/emails">
        {t("cta")}
      </a>
    </main>
  );
}
