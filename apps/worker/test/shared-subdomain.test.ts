import { defaultSafety, type SharedNameReview } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { JobPayloads } from "@millionsend/queue";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  queueMissingSharedSubdomains,
  runSharedSubdomainJob,
} from "../src/handlers/shared-subdomain.js";

const SHARED = "agents.example.test";
const NOW = new Date("2026-10-15T12:00:00Z");
const HOUR = 3_600_000;
const s = schema.sharedInboxDomains;

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

type Job = JobPayloads["shared.subdomain"];

const answers: SharedNameReview = async () => ({ refused: [] });
const down: SharedNameReview = async () => {
  throw new Error("judge down");
};

/** Runs one job at NOW with `review`, returning the successors it queued. */
async function run(job: Job, review: SharedNameReview) {
  const queued: { job: Job; startAfter: Date }[] = [];
  await runSharedSubdomainJob(
    db,
    {
      sharedInboxDomain: SHARED,
      review,
      requeue: async (next, startAfter) => {
        queued.push({ job: next, startAfter });
      },
      now: NOW,
    },
    job,
  );
  return queued;
}

const labelOf = async (teamId: string) =>
  (await db.select({ name: s.name }).from(s).where(eq(s.teamId, teamId)))[0]?.name ?? null;

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

describe("the shared.subdomain job", () => {
  it("settles the team's label once the review answers", async () => {
    const teamId = await createTeam(db, "acme");
    expect(await run({ teamId, since: hoursAgo(1) }, answers)).toEqual([]);
    expect(await labelOf(teamId)).toBe(`acme.${SHARED}`);
  });

  it("queues one successor an hour later, with the same since, while the review can't answer", async () => {
    const teamId = await createTeam(db, "acme");
    const job = { teamId, since: hoursAgo(23) };
    expect(await run(job, down)).toEqual([{ job, startAfter: new Date(NOW.getTime() + HOUR) }]);
    expect(await labelOf(teamId)).toBeNull();
  });

  it("gives a team still without a label team-<6> a day after since, and queues nothing", async () => {
    const teamId = await createTeam(db, "acme");
    expect(await run({ teamId, since: hoursAgo(24) }, down)).toEqual([]);
    expect(await labelOf(teamId)).toMatch(/^team-[a-z0-9]{6}\.agents\.example\.test$/);
  });

  it("keeps a renamed team's unlocked label past a day, and goes on retrying hourly", async () => {
    const teamId = await createTeam(db, "acme", { sharedInboxDomain: SHARED });
    await db.update(schema.teams).set({ name: "Renamed" }).where(eq(schema.teams.id, teamId));
    const job = { teamId, since: hoursAgo(30) };
    expect(await run(job, down)).toEqual([{ job, startAfter: new Date(NOW.getTime() + HOUR) }]);
    expect(await labelOf(teamId)).toBe(`acme.${SHARED}`);
  });
});

describe("queueMissingSharedSubdomains", () => {
  it("stamps a label an inbox is on, then queues every team without a label once, due now", async () => {
    const used = await createTeam(db, "used", { sharedInboxDomain: SHARED });
    const [label] = await db.select({ id: s.id }).from(s).where(eq(s.teamId, used));
    // Code from before the stamp gave the label an inbox and left locked_at null.
    await db.insert(schema.inboxes).values({
      teamId: used,
      kind: "agent",
      emailAddress: `bot@used.${SHARED}`,
      localPart: "bot",
      sharedDomainId: label?.id,
      name: "Bot",
      safety: defaultSafety("agent", true),
    });
    const fresh = await createTeam(db, "fresh");
    // Its job was lost: a failed enqueue, or spent retries.
    const lost = await createTeam(db, "lost");
    const sent: Job[][] = [];
    expect(
      await queueMissingSharedSubdomains(db, {
        sharedInboxDomain: SHARED,
        sendMany: async (jobs) => {
          sent.push(jobs);
        },
        now: NOW,
      }),
    ).toEqual({ stamped: 1, queued: 2 });
    const [stamp] = await db.select({ at: s.lockedAt }).from(s).where(eq(s.teamId, used));
    expect(stamp?.at).toBeInstanceOf(Date);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.arrayContaining([
        { teamId: fresh, since: NOW.toISOString() },
        { teamId: lost, since: NOW.toISOString() },
      ]),
    );
    expect(sent[0]).toHaveLength(2);
  });

  it("stamps and queues nothing without a shared domain", async () => {
    const used = await createTeam(db, "used", { sharedInboxDomain: SHARED });
    const [label] = await db.select({ id: s.id }).from(s).where(eq(s.teamId, used));
    await db.insert(schema.inboxes).values({
      teamId: used,
      kind: "agent",
      emailAddress: `bot@used.${SHARED}`,
      localPart: "bot",
      sharedDomainId: label?.id,
      name: "Bot",
      safety: defaultSafety("agent", true),
    });
    await createTeam(db, "fresh");
    const sent: Job[][] = [];
    expect(
      await queueMissingSharedSubdomains(db, {
        sharedInboxDomain: undefined,
        sendMany: async (jobs) => {
          sent.push(jobs);
        },
      }),
    ).toEqual({ stamped: 0, queued: 0 });
    expect(sent).toEqual([]);
    const [stamp] = await db.select({ at: s.lockedAt }).from(s).where(eq(s.teamId, used));
    expect(stamp?.at).toBeNull();
  });
});
