"use client";

import { useTranslations } from "next-intl";
import { type DomainRegion, regionFlag } from "./regions";

/**
 * "🇧🇷 São Paulo (sa-east-1)" — flag + localized city + region code.
 * `list` renders the code faint in parens; `meta` renders it mono muted.
 */
export function RegionLabel({
  region,
  variant = "list",
}: {
  region: string;
  variant?: "list" | "meta";
}) {
  const t = useTranslations("domains");
  return (
    <>
      {regionFlag(region)} {t(`regions.${region as DomainRegion}`)}{" "}
      {variant === "list" ? (
        <span style={{ color: "var(--ms-faint)" }}>({region})</span>
      ) : (
        <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
          {region}
        </span>
      )}
    </>
  );
}
