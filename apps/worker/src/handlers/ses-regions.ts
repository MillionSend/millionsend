import { bulkShare, type RegionBulkCounts, type RegionCapacity } from "@millionsend/core";
import type { SesAccountOverview } from "@millionsend/ses";
import { createTokenBucket } from "./send-email.js";
import { createSesQuotaGate, type SendQuotaControls } from "./ses-quota.js";

/**
 * The per-region send controls: SES's 24-hour quota and its maximum send rate
 * are both per region, so each served region gets its own quota gate and
 * token bucket, fed by one GetAccount probe per region. A send with no region
 * (platform mail, no domain row) and one in a region this deployment does not
 * serve use the default region's controls — the first served region — rather
 * than probing a region nothing was provisioned in.
 *
 * On top of the total gate sits the broadcast share: the part of the window
 * bulk mail may hold, with the rest kept for transactional mail. The room
 * left in it is what a fan-out may admit now and what the drain may release;
 * everything past it parks and waits.
 */
export interface RegionSendControls extends SendQuotaControls {
  /** Served regions, the default first. */
  readonly regions: readonly string[];
  /** Waits for a send token of the region's bucket. */
  throttle(region?: string): Promise<void>;
  /** Probes every region and re-reads the settings; a failure keeps that region's last answer. */
  refreshAll(): Promise<void>;
  /** The transactional reserve, percent of the quota. */
  reserve(): number;
  /** Rows broadcasts may hold in the region's window; Infinity when the quota is unlimited. */
  share(region?: string): number;
  /** The last successful GetAccount; null until one succeeds. */
  capacity(region?: string): RegionCapacity | null;
  /** The bucket rate this process applies, messages per second. */
  rate(region?: string): number;
  bulkSent24h(region?: string): number;
  /** Rows a fan-out may admit into the share right now. */
  room(region?: string): number;
  bulkExhausted(region?: string): boolean;
  paused(region?: string): boolean;
  /** Grants a walk up to `n` rows of the room and records the grant until the count sees the rows. */
  take(region: string | undefined, walkId: string, n: number): number;
  progress(walkId: string, emitted: number): void;
  done(walkId: string): void;
  /** Re-reads the bulk counts and the held regions; a failure keeps the last numbers. */
  recount(opts?: { attempts?: number }): Promise<void>;
  noteBulkSent(region?: string): void;
  /** Parked rows the drain released: queued until the next count sees them. */
  noteBulkQueued(region: string | undefined, n: number): void;
  noteTransactionalParked(region?: string): void;
  txParkedAt(region?: string): Date | null;
}

/** Probes between two bulk counts: the counts walk a day of sends, the probe is one GetAccount. */
const RECOUNT_EVERY_TICKS = 5;
const RECOUNT_RETRY_MS = 500;
const RESERVE_DEFAULT = 30;

interface Grant {
  region: string;
  admitted: number;
  emitted: number;
  /** Rows of this grant the last count already saw. */
  counted: number;
  closed: boolean;
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
  /** The transactional reserve, percent; absent = the default. */
  reserve?: (() => Promise<number>) | undefined;
  /** Bulk sends and queued bulk rows per region; absent = no pacing counts (tests). */
  counts?: (() => Promise<Map<string, Pick<RegionBulkCounts, "sent24h" | "queued">>>) | undefined;
  /** Regions whose broadcasts the breaker or an operator holds. */
  paused?: (() => Promise<Set<string>>) | undefined;
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
  let reserve = RESERVE_DEFAULT;
  // Bulk stays closed until a count has succeeded once; without a counter
  // there is nothing to wait for.
  let countsOk = !opts.counts;
  let pausedRegions = new Set<string>();
  let ticks = 0;
  const grants = new Map<string, Grant>();
  let folded = 0;
  const controls = new Map(
    opts.regions.map((region) => {
      const state = {
        quota: null as RegionCapacity | null,
        rate: opts.initialRate / opts.replicas,
        dbBulkSent: 0,
        dbBulkQueued: 0,
        sentSince: 0,
        queuedSince: 0,
        txParkedAt: null as Date | null,
      };
      const gate = createSesQuotaGate(
        async () => {
          const quota = await opts.read(region);
          state.quota = quota;
          return quota;
        },
        (err) => onError(region, err),
      );
      const bucket = createTokenBucket(state.rate);
      const probe = async (): Promise<boolean> => {
        const exhausted = await gate.refresh();
        // A region that never reported a rate (every probe failed) runs at the ceiling.
        state.rate = Math.min(state.quota?.maxSendRate || ceiling, ceiling) / opts.replicas;
        bucket.setRate(state.rate);
        return exhausted;
      };
      return [region, { gate, bucket, probe, state }] as const;
    }),
  );
  const pick = (region?: string) => {
    const key = region !== undefined && controls.has(region) ? region : defaultRegion;
    const control = controls.get(key);
    if (!control) throw new Error(`no send controls for ${defaultRegion}`);
    return { key, ...control };
  };
  const shareOf = (c: ReturnType<typeof pick>) =>
    c.state.quota ? bulkShare(c.state.quota.max24h, reserve) : Number.POSITIVE_INFINITY;
  const bulkSent = (c: ReturnType<typeof pick>) => c.state.dbBulkSent + c.state.sentSince;
  const outstanding = (key: string) => {
    let sum = 0;
    for (const g of grants.values()) if (g.region === key) sum += g.admitted - g.counted;
    return sum;
  };
  const room = (region?: string): number => {
    const c = pick(region);
    const share = shareOf(c);
    if (!Number.isFinite(share)) return share;
    if (c.gate.exhausted() || !countsOk) return 0;
    return Math.max(
      0,
      share - bulkSent(c) - (c.state.dbBulkQueued + c.state.queuedSince) - outstanding(c.key),
    );
  };
  const readPaused = async () => {
    if (!opts.paused) return;
    try {
      pausedRegions = await opts.paused();
    } catch (err) {
      console.warn("paused regions read failed", err);
    }
  };
  const recount = async ({ attempts = 1 } = {}) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // What each walk had written, and what the lane and the drain had
      // noted, when the count started: anything after that is not in the
      // count and stays on the ledger until the next one. Keyed by the grant
      // itself, since a re-take moves a grant under a new key.
      const seen = new Map([...grants.values()].map((g) => [g, g.emitted]));
      const since = new Map(
        [...controls].map(([region, c]) => [
          region,
          { sent: c.state.sentSince, queued: c.state.queuedSince },
        ]),
      );
      try {
        const counts = opts.counts ? await opts.counts() : new Map<string, RegionBulkCounts>();
        await readPaused();
        for (const [region, control] of controls) {
          const c = counts.get(region);
          const before = since.get(region) ?? { sent: 0, queued: 0 };
          control.state.dbBulkSent = c?.sent24h ?? 0;
          control.state.dbBulkQueued = c?.queued ?? 0;
          control.state.sentSince -= before.sent;
          control.state.queuedSince -= before.queued;
        }
        // The count covers what each grant had written when it started; a
        // closed grant leaves once a count has seen all of it.
        for (const [id, g] of grants) {
          const counted = seen.get(g);
          if (counted === undefined) continue;
          g.counted = counted;
          if (g.closed) {
            g.admitted = g.emitted;
            if (counted === g.emitted) grants.delete(id);
          }
        }
        countsOk = true;
        return;
      } catch (err) {
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, RECOUNT_RETRY_MS * attempt));
        } else {
          console.warn(
            countsOk
              ? "bulk region counts failed; the last counts stand"
              : "bulk region counts never succeeded; broadcasts park until the first count",
            err,
          );
        }
      }
    }
  };
  return {
    regions: opts.regions,
    exhausted: (region) => pick(region).gate.exhausted(),
    refresh: (region) => pick(region).probe(),
    throttle: (region) => pick(region).bucket.take(),
    async refreshAll() {
      try {
        ceiling = await opts.ceiling();
        if (opts.reserve) reserve = await opts.reserve();
      } catch (err) {
        // Transient db failure keeps the last applied settings.
        console.warn("send settings read failed", err);
      }
      for (const control of controls.values()) await control.probe();
      if (ticks % RECOUNT_EVERY_TICKS === 0) await recount({ attempts: ticks === 0 ? 3 : 1 });
      else await readPaused();
      ticks += 1;
    },
    reserve: () => reserve,
    share: (region) => shareOf(pick(region)),
    capacity: (region) => pick(region).state.quota,
    rate: (region) => pick(region).state.rate,
    bulkSent24h: (region) => bulkSent(pick(region)),
    room,
    bulkExhausted: (region) => {
      const c = pick(region);
      const share = shareOf(c);
      if (!Number.isFinite(share)) return false;
      return bulkSent(c) >= share || c.gate.exhausted() || !countsOk;
    },
    paused: (region) => pausedRegions.has(pick(region).key),
    take: (region, walkId, n) => {
      const c = pick(region);
      // A walk taking again (a retry, a resume): its earlier grant keeps
      // only the rows it wrote, until a count sees them.
      const prev = grants.get(walkId);
      if (prev) {
        prev.admitted = prev.emitted;
        prev.closed = true;
        grants.set(`${walkId}#${folded++}`, prev);
        grants.delete(walkId);
      }
      const admitted = Math.min(n, room(c.key));
      grants.set(walkId, { region: c.key, admitted, emitted: 0, counted: 0, closed: false });
      return admitted;
    },
    progress: (walkId, emitted) => {
      const g = grants.get(walkId);
      if (g) g.emitted = emitted;
    },
    done: (walkId) => {
      const g = grants.get(walkId);
      if (g) g.closed = true;
    },
    recount,
    noteBulkSent: (region) => {
      pick(region).state.sentSince += 1;
    },
    noteBulkQueued: (region, n) => {
      pick(region).state.queuedSince += n;
    },
    noteTransactionalParked: (region) => {
      pick(region).state.txParkedAt = new Date();
    },
    txParkedAt: (region) => pick(region).state.txParkedAt,
  };
}
