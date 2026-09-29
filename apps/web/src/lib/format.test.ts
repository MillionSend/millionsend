import { expect, it } from "vitest";
import { sendingDays } from "./format";

it("merges what went out with what is planned, one row per local day", () => {
  process.env.TZ = "America/Sao_Paulo";
  const now = new Date("2026-09-30T15:00:00Z");
  const days = sendingDays(
    [
      { at: new Date("2026-09-29T14:45:00Z"), count: 60_000 },
      { at: new Date("2026-09-29T16:00:00Z"), count: 10_000 },
      { at: new Date("2026-09-30T14:45:00Z"), count: 20_000 },
    ],
    [
      { at: now, endsAt: new Date("2026-09-30T16:15:00Z"), count: 50_000 },
      {
        at: new Date("2026-10-01T14:45:00Z"),
        endsAt: new Date("2026-10-01T15:45:00Z"),
        count: 42_000,
      },
    ],
    now,
  );
  expect(days.map((d) => [d.state, d.count, d.sent])).toEqual([
    ["done", 70_000, 70_000],
    ["now", 70_000, 20_000],
    ["next", 42_000, 0],
  ]);
});
