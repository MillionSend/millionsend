import { env, servedRegions } from "@millionsend/config";
import {
  createSesAccountClient,
  getAccountOverview,
  type SesAccountClient,
  type SesAccountOverview,
} from "@millionsend/ses";

/** The non-send SES API is throttled at one request a second per region; a minute of reuse keeps every console read under it. */
const ACCOUNT_CACHE_MS = 60_000;

export type RegionAccount =
  | { region: string; ok: true; overview: SesAccountOverview; probedAt: Date; latencyMs: number }
  | { region: string; ok: false; message: string; probedAt: Date };

export interface RegionAccountDeps {
  accountClient(region: string): SesAccountClient;
  now?(): Date;
}

export const defaultRegionAccountDeps: RegionAccountDeps = {
  accountClient: (region) =>
    createSesAccountClient({
      region,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }),
};

const cache = new Map<string, { at: number; value: Promise<RegionAccount> }>();
let activeDeps: RegionAccountDeps = defaultRegionAccountDeps;

/** Tests: swap the SES client factory (and clear the cache) instead of stubbing the AWS SDK. */
export function setRegionAccountDeps(deps: RegionAccountDeps | null): void {
  activeDeps = deps ?? defaultRegionAccountDeps;
  cache.clear();
}

async function probe(region: string, deps: RegionAccountDeps): Promise<RegionAccount> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  try {
    const overview = await getAccountOverview(deps.accountClient(region));
    return { region, ok: true, overview, probedAt: now, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      region,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      probedAt: now,
    };
  }
}

/** GetAccount for one region, reused for a minute; `fresh` re-reads now. */
export function regionAccount(
  region: string,
  opts: { fresh?: boolean; deps?: RegionAccountDeps } = {},
): Promise<RegionAccount> {
  const deps = opts.deps ?? activeDeps;
  const hit = cache.get(region);
  if (!opts.fresh && hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.value;
  const value = probe(region, deps);
  cache.set(region, { at: Date.now(), value });
  return value;
}

/** Every served region's account, in served order. */
export function servedRegionAccounts(
  opts: { fresh?: boolean; deps?: RegionAccountDeps } = {},
): Promise<RegionAccount[]> {
  return Promise.all(servedRegions().map((region) => regionAccount(region, opts)));
}

/** Tests: forget every cached answer. */
export function resetRegionAccountCache(): void {
  cache.clear();
}
