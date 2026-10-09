import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isValidMonitorSetting,
  MONITOR_SETTING_DEFAULTS,
  MONITOR_SETTING_KEYS,
  monitorSettingsReader,
  monitorThresholdsOrdered,
  resolveMonitorSettings,
} from "../src/monitor-settings.js";

describe("resolveMonitorSettings", () => {
  it("falls through db, env and default per key", () => {
    const { settings, sources } = resolveMonitorSettings(
      { monitorFirstSends: 500, monitorAutoPause: false, monitorRampRate: null },
      { MONITOR_RAMP_RATE: "0.4", MONITOR_FIRST_SENDS: "9", MONITOR_TRUSTED_RATE: 0.01 },
    );
    expect(settings.firstSends).toBe(500);
    expect(sources.firstSends).toBe("db");
    expect(settings.autoPause).toBe(false);
    expect(settings.rampRate).toBe(0.4);
    expect(sources.rampRate).toBe("env");
    expect(settings.trustedRate).toBe(0.01);
    expect(settings.probationRate).toBe(0.05);
    expect(sources.probationRate).toBe("default");
    expect(resolveMonitorSettings(null, {}).settings).toEqual(MONITOR_SETTING_DEFAULTS);
  });

  it("ignores values that are not valid for their kind", () => {
    const { settings } = resolveMonitorSettings(
      { monitorRampRate: 1.5, monitorTeamDailyCap: -1 },
      { MONITOR_RAMP_RATE: "abc", MONITOR_AUTO_PAUSE: "maybe", MONITOR_FLAG_SCORE: "70.5" },
    );
    expect(settings.rampRate).toBe(0.25);
    expect(settings.teamDailyCap).toBe(600);
    expect(settings.autoPause).toBe(true);
    expect(settings.flagScore).toBe(70);
    expect(isValidMonitorSetting("anomalyMultiplier", 0.5)).toBe(false);
    expect(isValidMonitorSetting("autoPause", 1)).toBe(false);
    expect(resolveMonitorSettings(null, { MONITOR_AUTO_PAUSE: "0" }).settings.autoPause).toBe(
      false,
    );
  });

  it("orders the thresholds and knows every key", () => {
    expect(monitorThresholdsOrdered(MONITOR_SETTING_DEFAULTS)).toBe(true);
    expect(monitorThresholdsOrdered({ flagRisk: 0.7, alertRisk: 0.7, pauseRisk: 0.9 })).toBe(false);
    expect(MONITOR_SETTING_KEYS).toHaveLength(22);
  });
});

describe("monitorSettingsReader", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("re-reads the row once the ttl lapses and keeps the last answer on a failing read", async () => {
    let clock = 1_000_000;
    const read = monitorSettingsReader(
      db,
      { MONITOR_FIRST_HOURS: "48" },
      {
        ttlMs: 60_000,
        now: () => clock,
      },
    );
    expect(await read()).toMatchObject({ firstHours: 48, firstSends: 1000 });
    await db.insert(schema.instanceSettings).values({ id: 1, monitorFirstSends: 25 });
    expect((await read()).firstSends).toBe(1000);
    clock += 60_000;
    expect((await read()).firstSends).toBe(25);
    const broken = monitorSettingsReader(
      {
        select: () => {
          throw new Error("db down");
        },
      } as unknown as Db,
      {},
    );
    await expect(broken()).rejects.toThrow("db down");
  });
});
