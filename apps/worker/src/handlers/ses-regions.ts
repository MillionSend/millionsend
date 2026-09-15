import type { SesAccountOverview } from "@millionsend/ses";
import { createTokenBucket } from "./send-email.js";
import { createSesQuotaGate, type SesQuotaGate } from "./ses-quota.js";

/**
 * The per-region send controls: SES's 24-hour quota and its maximum send rate
 * are both per region, so each served region gets its own quota gate and
 * token bucket, fed by one GetAccount probe per region. A send with no region
 * (platform mail, no domain row) and one in a region this deployment does not
 * serve use the default region's controls — the first served region — rather
 * than probing a region nothing was provisioned in.
 */
export interface RegionSendControls extends SesQuotaGate {
  /** Served regions, the default first. */
  readonly regions: readonly string[];
  /** Waits for a send token of the region's bucket. */
  throttle(region?: string): Promise<void>;
  /** Probes every region and re-reads the rate ceiling; a failure keeps that region's last answer. */
  refreshAll(): Promise<void>;
}

export function createRegionSendControls(opts: {
  regions: readonly string[];
  /** One GetAccount in the region: the quota and MaxSendRate come from the same read. */
  read: (region: string) => Promise<SesAccountOverview["quota"]>;
  /**
   * Messages/second ceiling across regions (the instance setting, else
   * SES_MAX_SEND_RATE): a region's bucket runs at the lower of its own
   * MaxSendRate and this, so a sandbox region paces itself at its 1/s while
   * an operator can still hold a production region under its account rate.
   */
  ceiling: () => Promise<number>;
  /** Rate every bucket starts at until the first probe. */
  initialRate: number;
  /** Worker processes sharing the account: each bucket takes its share. */
  replicas: number;
  onError?: (region: string, err: unknown) => void;
}): RegionSendControls {
  const defaultRegion = opts.regions[0];
  if (!defaultRegion) throw new Error("at least one SES region is required");
  const onError =
    opts.onError ?? ((region, err) => console.warn(`SES account read failed for ${region}`, err));
  let ceiling = opts.initialRate;
  const controls = new Map(
    opts.regions.map((region) => {
      let maxSendRate = 0;
      const gate = createSesQuotaGate(
        async () => {
          const quota = await opts.read(region);
          maxSendRate = quota.maxSendRate;
          return quota;
        },
        (err) => onError(region, err),
      );
      const bucket = createTokenBucket(opts.initialRate / opts.replicas);
      const probe = async (): Promise<boolean> => {
        const exhausted = await gate.refresh();
        // A region that never reported a rate (every probe failed) runs at the ceiling.
        bucket.setRate(Math.min(maxSendRate || ceiling, ceiling) / opts.replicas);
        return exhausted;
      };
      return [region, { gate, bucket, probe }] as const;
    }),
  );
  const pick = (region?: string) => {
    const control =
      (region === undefined ? undefined : controls.get(region)) ?? controls.get(defaultRegion);
    if (!control) throw new Error(`no send controls for ${defaultRegion}`);
    return control;
  };
  return {
    regions: opts.regions,
    exhausted: (region) => pick(region).gate.exhausted(),
    refresh: (region) => pick(region).probe(),
    throttle: (region) => pick(region).bucket.take(),
    async refreshAll() {
      try {
        ceiling = await opts.ceiling();
      } catch (err) {
        // Transient db failure keeps the last applied ceiling.
        console.warn("send-rate ceiling read failed", err);
      }
      for (const control of controls.values()) await control.probe();
    },
  };
}
