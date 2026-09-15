import type { SesRegion } from "@millionsend/ses";

/**
 * Offered SES regions. Mirrors SES_REGIONS in @millionsend/ses — restated
 * here because that package's entry point is server-only (node:crypto) and
 * this list must reach the client bundle. The `satisfies` check keeps the
 * values within the canonical set.
 */
export const DOMAIN_REGIONS = [
  "us-east-1",
  "eu-west-1",
  "sa-east-1",
  "ap-northeast-1",
] as const satisfies readonly SesRegion[];

export type DomainRegion = (typeof DOMAIN_REGIONS)[number];

/** Whether a served region code has a localized name and flag; the wizard accepts any region name. */
export function isDomainRegion(code: string): code is DomainRegion {
  return (DOMAIN_REGIONS as readonly string[]).includes(code);
}

/** The localized city name of a known region ("São Paulo"), the raw code for any other served region. */
export function regionName(code: string, t: (key: `regions.${DomainRegion}`) => string): string {
  return isDomainRegion(code) ? t(`regions.${code}`) : code;
}

/** Flag emoji shown next to the localized region city name ("🇧🇷 São Paulo"). */
export const REGION_FLAGS: Record<DomainRegion, string> = {
  "us-east-1": "🇺🇸",
  "eu-west-1": "🇮🇪",
  "sa-east-1": "🇧🇷",
  "ap-northeast-1": "🇯🇵",
};

export function regionFlag(region: string): string {
  return REGION_FLAGS[region as DomainRegion] ?? "";
}
