import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { noteForDigest, sendMonitorDigest } from "../src/handlers/monitor-digest.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(() => close());

it("mails the operator one digest of counts per team, once, and nothing when empty", async () => {
  const mails: { to: string; kind: string; text: string }[] = [];
  const deps = {
    mailer: {
      send: async (to: string, m: { kind: string; text: string }) =>
        void mails.push({ to, kind: m.kind, text: m.text }),
    },
    appBaseUrl: "https://app.example.test",
  };
  expect(await sendMonitorDigest(db, deps)).toBe(0);
  expect(mails).toEqual([]);

  const acme = await createTeam(db, "acme");
  const bolt = await createTeam(db, "bolt");
  await noteForDigest(db, acme, "destination_parked");
  await noteForDigest(db, acme, "destination_parked");
  await noteForDigest(db, acme, "destination_revoked");
  await noteForDigest(db, bolt, "media_blocked");

  const [first, second] = await Promise.all([
    sendMonitorDigest(db, deps),
    sendMonitorDigest(db, deps),
  ]);
  expect([first, second].sort()).toEqual([0, 2]);
  expect(mails).toMatchObject([{ to: "op@example.com", kind: "monitor.digest" }]);
  const text = mails[0]?.text ?? "";
  expect(text).toContain(
    `acme: 2 times mail to new destinations was parked and 1 email that took a destination's clearance back. https://app.example.test/console/safety/${acme}`,
  );
  expect(text).toContain(
    `bolt: 1 email whose images the image reader refused. https://app.example.test/console/safety/${bolt}`,
  );

  expect(await sendMonitorDigest(db, deps)).toBe(0);
  expect(mails).toHaveLength(1);
});

it("keeps the counts for the next digest when the mail fails", async () => {
  const team = await createTeam(db, "kept");
  await noteForDigest(db, team, "destination_parked");
  const failing = {
    send: async () => {
      throw new Error("Throttling");
    },
  };
  expect(await sendMonitorDigest(db, { mailer: failing })).toBe(0);
  await noteForDigest(db, team, "destination_parked");
  const rows = await db.select().from(schema.monitorDigest);
  expect(rows).toMatchObject([{ teamId: team, kind: "destination_parked", count: 2 }]);
});

it("names the vouches that end within three days, and never one until revoked", async () => {
  const mails: { text: string }[] = [];
  const deps = {
    mailer: { send: async (_to: string, m: { text: string }) => void mails.push(m) },
    appBaseUrl: "https://app.example.test",
    now: new Date("2026-11-18T12:00:00Z"),
  };
  const vouch = async (slug: string, until: Date | null) => {
    const teamId = await createTeam(db, slug);
    await db.insert(schema.teamMonitor).values({
      teamId,
      vouchedAt: new Date("2026-10-01T00:00:00Z"),
      vouchedBy: "op",
      vouchReason: "checked",
      vouchUntil: until,
    });
    return teamId;
  };
  const ending = await vouch("ending", new Date("2026-11-20T09:00:00Z"));
  await vouch("later", new Date("2026-11-25T00:00:00Z"));
  await vouch("ended", new Date("2026-11-18T11:00:00Z"));
  await vouch("forever", null);
  // The counts the previous case kept are not this case's.
  await db.delete(schema.monitorDigest);

  expect(await sendMonitorDigest(db, deps)).toBe(1);
  expect(mails[0]?.text).toContain(
    `ending: the vouch for its content ends on 2026-11-20 (UTC). https://app.example.test/console/safety/${ending}`,
  );
  for (const slug of ["later", "ended", "forever"]) expect(mails[0]?.text).not.toContain(slug);
});
