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
