import { useTranslations } from "next-intl";

/** Marks a feature still in beta, riding after its label (the broadcast-chip box). */
export function BetaPill() {
  const t = useTranslations("common");
  return (
    <span className="ms-chip" style={{ fontSize: 10.5, padding: "1px 7px", marginLeft: 7 }}>
      {t("beta")}
    </span>
  );
}
