import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as common from "../src/inboxes/inbox-common.js";
import { createInbox, deleteInboxes, type InboxDeps } from "../src/inboxes/inboxes.js";
import { SHARED_NAME_REVIEWS_PER_DAY } from "../src/inboxes/limits.js";
import { defaultSafety } from "../src/inboxes/safety.js";
import {
  lockUsedSharedSubdomains,
  RESERVED_SHARED_LABELS,
  releaseSharedSubdomain,
  reservedSharedName,
  type SharedNameReview,
  settleSharedSubdomain,
  teamSharedDomain,
} from "../src/inboxes/shared-domain.js";
import { utcDay } from "../src/utc-day.js";

vi.mock("../src/inboxes/inbox-common.js", async (original) => {
  const real = await original<typeof import("../src/inboxes/inbox-common.js")>();
  return { ...real, randomAlnum: vi.fn(real.randomAlnum) };
});

const SHARED = "agents.example.test";
const SHARED_RE = SHARED.replaceAll(".", "\\.");
const RANDOM_LABEL = new RegExp(`^team-[a-z0-9]{6}\\.${SHARED_RE}$`);
const deps: InboxDeps = { sharedInboxDomain: SHARED, receivingEnabled: true };
const s = schema.sharedInboxDomains;

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

/** A team called `name`, without a label yet. Labels are unique across the file's teams. */
async function team(name: string): Promise<string> {
  const [row] = await db
    .insert(schema.teams)
    .values({ name, slug: `t-${randomUUID()}` })
    .returning({ id: schema.teams.id });
  if (!row) throw new Error("team insert failed");
  return row.id;
}

const rename = (teamId: string, name: string) =>
  db.update(schema.teams).set({ name }).where(eq(schema.teams.id, teamId));

const settle = (teamId: string, more: Partial<Parameters<typeof settleSharedSubdomain>[1]> = {}) =>
  settleSharedSubdomain(db, {
    teamId,
    sharedInboxDomain: SHARED,
    review: undefined,
    now: new Date(),
    ...more,
  });

const label = async (teamId: string) => (await teamSharedDomain(db, teamId))?.name ?? null;

const lockedAt = async (teamId: string) =>
  (await db.select({ at: s.lockedAt }).from(s).where(eq(s.teamId, teamId)))[0]?.at;

/** A review answering `refused` (an Error: it can't answer) after running `during`; `asked` records it. */
function reviewer(refused: string[] | Error = [], during?: () => Promise<unknown>) {
  const asked: string[] = [];
  const review: SharedNameReview = async (texts) => {
    asked.push(...texts.map((text) => text.value));
    await during?.();
    if (refused instanceof Error) throw refused;
    return { refused };
  };
  return { review, asked };
}

const create = (
  teamId: string,
  input: Parameters<typeof createInbox>[2]["input"],
  inboxDeps: InboxDeps = deps,
  onlyDomainId?: string,
) =>
  createInbox(db, inboxDeps, {
    teamId,
    plan: "pro",
    isCloud: true,
    actor: { kind: "user", userId: "user-1" },
    input,
    onlyDomainId,
  });

async function domainOf(
  teamId: string,
  name: string,
  over: Partial<typeof schema.domains.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
      ...over,
    })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

describe("reservedSharedName", () => {
  it("compares usernames without case or separators", () => {
    for (const name of ["postmaster", "Post-Master", "no.reply", "noreply", "mailer_daemon"]) {
      expect(reservedSharedName(name)).toBe(true);
    }
    expect(reservedSharedName("leo")).toBe(false);
    expect(reservedSharedName("postmasters")).toBe(false);
  });

  it("reserves mail service names as labels, not as usernames", () => {
    expect(reservedSharedName("www")).toBe(false);
    expect(reservedSharedName("www", RESERVED_SHARED_LABELS)).toBe(true);
    expect(reservedSharedName("auto-discover", RESERVED_SHARED_LABELS)).toBe(true);
    expect(reservedSharedName("abuse", RESERVED_SHARED_LABELS)).toBe(true);
  });
});

describe("random names on the shared domain", () => {
  it("draws a refused random label again whole: every suffix of team-dhl853 still reads as DHL", async () => {
    vi.mocked(common.randomAlnum).mockReturnValueOnce("dhl853");
    const teamId = await team("株式会社");
    expect(await settle(teamId)).toBe("settled");
    expect(await label(teamId)).toMatch(RANDOM_LABEL);
    expect(await label(teamId)).not.toContain("dhl853");
  });

  it("draws a random address again when it spells a brand look-alike", async () => {
    const teamId = await team("Draw Address");
    await settle(teamId);
    vi.mocked(common.randomAlnum).mockReturnValueOnce("dhl12345");
    const created = await create(teamId, {});
    expect(created.ok && created.inbox.email_address).toMatch(
      new RegExp(`^inbox-[a-z0-9]{8}@draw-address\\.${SHARED_RE}$`),
    );
    expect(created.ok && created.inbox.email_address).not.toContain("dhl12345");
  });
});

describe("settleSharedSubdomain for a new team", () => {
  it("names the label after the team once the review passes it, and keeps it without asking again", async () => {
    const teamId = await team("Acme");
    const { review, asked } = reviewer();
    expect(await settle(teamId, { review })).toBe("settled");
    expect(await label(teamId)).toBe(`acme.${SHARED}`);
    expect(await settle(teamId, { review })).toBe("settled");
    expect(asked).toEqual(["acme"]);
    expect(await lockedAt(teamId)).toBeNull();
  });

  it("gives brand, reserved and slugless names team-<6> without a review, and cuts a long name", async () => {
    const { review, asked } = reviewer();
    for (const name of [
      "PayPal Support",
      "paypalsupport",
      // The 30-character cut leaves "aaaaaaaaaaaaaaaaaaaaaaa-paypal".
      "aaaaaaaaaaaaaaaaaaaaaaa paypalish",
      "Mail",
      "WWW",
      "Post-Master",
      "Team",
      "株式会社",
    ]) {
      const teamId = await team(name);
      expect(await settle(teamId, { review }), name).toBe("settled");
      expect(await label(teamId), name).toMatch(RANDOM_LABEL);
    }
    expect(asked).toEqual([]);
    for (const [name, slug] of [
      ["abcdefghijklmnopqrstuvwxyzabc def", "abcdefghijklmnopqrstuvwxyzabc"],
      ["Ação Robots, Inc.", "acao-robots-inc"],
    ] as const) {
      const teamId = await team(name);
      await settle(teamId);
      expect(await label(teamId)).toBe(`${slug}.${SHARED}`);
    }
  });

  it("suffixes a label another team holds, and never hands out a deleted team's label again", async () => {
    const first = await team("Clash Co");
    const second = await team("Clash Co");
    await settle(first);
    await settle(second);
    expect(await label(first)).toBe(`clash-co.${SHARED}`);
    expect(await label(second)).toMatch(new RegExp(`^clash-co-[a-z0-9]{4}\\.${SHARED_RE}$`));
    const gone = await team("Tombstone Labs");
    await settle(gone);
    await create(gone, {});
    await db.delete(schema.teams).where(eq(schema.teams.id, gone));
    const next = await team("Tombstone Labs");
    await settle(next);
    expect(await label(next)).toMatch(new RegExp(`^tombstone-labs-[a-z0-9]{4}\\.${SHARED_RE}$`));
  });
});

describe("settleSharedSubdomain after a rename", () => {
  it("moves an unlocked label in place, and its old name goes to another team unsuffixed", async () => {
    const teamId = await team("Rename Old");
    await settle(teamId);
    const before = await teamSharedDomain(db, teamId);
    await rename(teamId, "Rename New");
    expect(await settle(teamId)).toBe("settled");
    expect(await teamSharedDomain(db, teamId)).toEqual({ ...before, name: `rename-new.${SHARED}` });
    const other = await team("Rename Old");
    await settle(other);
    expect(await label(other)).toBe(`rename-old.${SHARED}`);
  });

  it("keeps the label for a name with the same slug, spending no review", async () => {
    const teamId = await team("Same Slug");
    await settle(teamId);
    await rename(teamId, "SAME slug");
    const { review, asked } = reviewer();
    expect(await settle(teamId, { review })).toBe("settled");
    expect(await label(teamId)).toBe(`same-slug.${SHARED}`);
    expect(asked).toEqual([]);
  });

  it("writes nothing for the name it reviewed when a rename to another slug lands meanwhile", async () => {
    const teamId = await team("Race Before");
    await settle(teamId);
    await rename(teamId, "Race Middle");
    const { review, asked } = reviewer([], () => rename(teamId, "Race After"));
    expect(await settle(teamId, { review })).toBe("settled");
    expect(asked).toEqual(["race-middle"]);
    expect(await label(teamId)).toBe(`race-before.${SHARED}`);
  });

  it("follows a rename to the same slug made during its review, on that one review", async () => {
    const teamId = await team("Foo Labs");
    await settle(teamId);
    await rename(teamId, "Orbit Desk");
    const { review, asked } = reviewer([], () => rename(teamId, "ORBIT DESK"));
    expect(await settle(teamId, { review })).toBe("settled");
    expect(await label(teamId)).toBe(`orbit-desk.${SHARED}`);
    expect(asked).toEqual(["orbit-desk"]);
  });

  it("gives a refused new name team-<6>, and keeps that label for the next refused name", async () => {
    const teamId = await team("Plain Name");
    await settle(teamId);
    await rename(teamId, "Sly Name");
    expect(await settle(teamId, { review: reviewer(["sly-name"]).review })).toBe("settled");
    const random = await label(teamId);
    expect(random).toMatch(RANDOM_LABEL);
    await rename(teamId, "Sly Other");
    const { review, asked } = reviewer(["sly-other"]);
    expect(await settle(teamId, { review })).toBe("settled");
    expect(asked).toEqual(["sly-other"]);
    expect(await label(teamId)).toBe(random);
  });
});

describe("settleSharedSubdomain while the review can't answer", () => {
  it("writes nothing and answers unavailable; with the review back it names the label", async () => {
    const teamId = await team("Outage Co");
    expect(await settle(teamId, { review: reviewer(new Error("down")).review })).toBe(
      "unavailable",
    );
    expect(await label(teamId)).toBeNull();
    expect(await settle(teamId, { review: reviewer().review })).toBe("settled");
    expect(await label(teamId)).toBe(`outage-co.${SHARED}`);
  });

  it("answers unavailable once the team's reviews for the day are spent", async () => {
    const teamId = await team("Spent Co");
    const now = new Date();
    await db.insert(schema.usageCounters).values({
      teamId,
      day: utcDay(now),
      sharedNameReviews: SHARED_NAME_REVIEWS_PER_DAY,
    });
    const { review, asked } = reviewer();
    expect(await settle(teamId, { review, now })).toBe("unavailable");
    expect(asked).toEqual([]);
    expect(await label(teamId)).toBeNull();
  });

  it("gives up to team-<6> for a team without a label, never for one that has a label", async () => {
    const down = reviewer(new Error("down")).review;
    const fresh = await team("Give Up Co");
    expect(await settle(fresh, { review: down, giveUp: true })).toBe("settled");
    expect(await label(fresh)).toMatch(RANDOM_LABEL);
    const renamed = await team("Keep Old");
    await settle(renamed);
    await rename(renamed, "Keep New");
    expect(await settle(renamed, { review: down, giveUp: true })).toBe("unavailable");
    expect(await label(renamed)).toBe(`keep-old.${SHARED}`);
  });
});

describe("locking the label", () => {
  it("locks it with the first shared inbox; a later rename and the inbox's deletion leave it", async () => {
    const teamId = await team("Lock Shared");
    await settle(teamId);
    const created = await create(teamId, {});
    if (!created.ok) throw new Error(created.error.message);
    expect(await lockedAt(teamId)).toBeInstanceOf(Date);
    await rename(teamId, "Lock Moved");
    expect(await settle(teamId)).toBe("settled");
    expect(await label(teamId)).toBe(`lock-shared.${SHARED}`);
    await deleteInboxes(db, deps, {
      teamId,
      inboxIds: [created.inbox.id],
      actor: { kind: "system" },
      reason: "deleted",
    });
    expect(await settle(teamId)).toBe("settled");
    expect(await label(teamId)).toBe(`lock-shared.${SHARED}`);
    expect(await lockedAt(teamId)).toBeInstanceOf(Date);
  });

  it("locks it with a forwarding inbox too, never with a create that answers 409", async () => {
    const teamId = await team("Lock Forward");
    await settle(teamId);
    await domainOf(teamId, "lock-forward.example.com");
    expect((await create(teamId, { email_address: "help@lock-forward.example.com" })).ok).toBe(
      true,
    );
    const taken = await create(teamId, {
      email_address: "help@lock-forward.example.com",
      forwarding: true,
    });
    expect(taken.ok ? null : taken.error.status).toBe(409);
    expect(await lockedAt(teamId)).toBeNull();
    const forwarding = await create(teamId, {
      email_address: "desk@lock-forward.example.com",
      forwarding: true,
    });
    expect(forwarding.ok && forwarding.inbox.receiving_address).toMatch(
      new RegExp(`^fwd-[a-z0-9]{16}@lock-forward\\.${SHARED_RE}$`),
    );
    expect(await lockedAt(teamId)).toBeInstanceOf(Date);
  });

  it("puts the address on the name the label has when the create locks it", async () => {
    const teamId = await team("Mid Before");
    await settle(teamId);
    // The username's review is where a rename can land mid-create.
    const { review } = reviewer([], async () => {
      await rename(teamId, "Mid After");
      await settle(teamId);
    });
    const created = await create(
      teamId,
      { username: "desk" },
      { ...deps, judgeSharedNames: review },
    );
    expect(created.ok && created.inbox.email_address).toBe(`desk@mid-after.${SHARED}`);
    expect(created.ok && created.inbox.domain_id).toBe((await teamSharedDomain(db, teamId))?.id);
  });

  it("counts an inbox that older code put on the label without a stamp as a lock, which lockUsedSharedSubdomains stamps", async () => {
    const teamId = await team("Old Code");
    await settle(teamId);
    expect((await create(teamId, {})).ok).toBe(true);
    await db.update(s).set({ lockedAt: null }).where(eq(s.teamId, teamId));
    await rename(teamId, "New Code");
    expect(await settle(teamId)).toBe("settled");
    expect(await label(teamId)).toBe(`old-code.${SHARED}`);
    expect(await lockUsedSharedSubdomains(db)).toBeGreaterThanOrEqual(1);
    expect(await lockedAt(teamId)).toBeInstanceOf(Date);
  });

  it("leaves the label as it is when a lock lands during the review", async () => {
    const stamped = await team("Stamp Before");
    await settle(stamped);
    await rename(stamped, "Stamp After");
    const stamp = reviewer([], () => create(stamped, {}));
    expect(await settle(stamped, { review: stamp.review })).toBe("settled");
    expect(await label(stamped)).toBe(`stamp-before.${SHARED}`);
    // An inbox written by code from before the stamp locks the label too.
    const unstamped = await team("Inbox Before");
    await settle(unstamped);
    await rename(unstamped, "Inbox After");
    const inbox = reviewer([], async () => {
      const sub = await teamSharedDomain(db, unstamped);
      await db.insert(schema.inboxes).values({
        teamId: unstamped,
        kind: "agent",
        emailAddress: `bot@${sub?.name}`,
        localPart: "bot",
        sharedDomainId: sub?.id,
        name: "Bot",
        safety: defaultSafety("agent", true),
      });
    });
    expect(await settle(unstamped, { review: inbox.review })).toBe("settled");
    expect(await label(unstamped)).toBe(`inbox-before.${SHARED}`);
  });
});

describe("releaseSharedSubdomain", () => {
  it("frees an unlocked label with its team, and keeps a stamped one and one with an inbox as tombstones", async () => {
    const free = await team("Release Free");
    const stamped = await team("Release Stamped");
    const used = await team("Release Used");
    for (const teamId of [free, stamped, used]) await settle(teamId);
    expect((await create(stamped, {})).ok).toBe(true);
    expect((await create(used, {})).ok).toBe(true);
    await db.update(s).set({ lockedAt: null }).where(eq(s.teamId, used));
    for (const teamId of [free, stamped, used]) {
      await db.transaction(async (tx) => {
        await releaseSharedSubdomain(tx as unknown as Db, teamId);
        await tx.delete(schema.teams).where(eq(schema.teams.id, teamId));
      });
    }
    const left = async (name: string) =>
      (
        await db
          .select({ teamId: s.teamId })
          .from(s)
          .where(eq(s.name, `${name}.${SHARED}`))
      )[0];
    expect(await left("release-free")).toBeUndefined();
    expect(await left("release-stamped")).toEqual({ teamId: null });
    expect(await left("release-used")).toEqual({ teamId: null });
    const next = await team("Release Free");
    await settle(next);
    expect(await label(next)).toBe(`release-free.${SHARED}`);
  });
});

describe("createInbox while the team's label is pending", () => {
  it("answers 503 with retry-after 300 for shared and forwarding creates, before any review", async () => {
    const teamId = await team("Pending Co");
    await domainOf(teamId, "pending.example.com");
    const { review, asked } = reviewer();
    const pending = {
      ok: false,
      error: {
        status: 503,
        name: "name_review_unavailable",
        message:
          "Your team's subdomain on the shared domain is waiting for its name review: try again shortly",
        retryAfterSec: 300,
      },
    };
    expect(
      await create(
        teamId,
        { username: "desk", from_name: "Desk" },
        { ...deps, judgeSharedNames: review },
      ),
    ).toEqual(pending);
    expect(
      await create(teamId, { email_address: "fw@pending.example.com", forwarding: true }),
    ).toEqual(pending);
    expect(asked).toEqual([]);
    expect(
      await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, teamId)),
    ).toEqual([]);
  });
});

describe("createInbox with domain_id", () => {
  it("takes the team's shared subdomain id in either case as the shared domain", async () => {
    const teamId = await team("Domain Shared");
    await settle(teamId);
    const sub = await teamSharedDomain(db, teamId);
    if (!sub) throw new Error("no label");
    const chosen = await create(teamId, { domain_id: sub.id, username: "desk" });
    expect(chosen.ok && chosen.inbox).toMatchObject({
      email_address: `desk@domain-shared.${SHARED}`,
      domain_id: sub.id,
      shared: true,
    });
    const random = await create(teamId, { domain_id: sub.id.toUpperCase() });
    expect(random.ok && random.inbox.email_address).toMatch(
      new RegExp(`^inbox-[a-z0-9]{8}@domain-shared\\.${SHARED_RE}$`),
    );
  });

  it("takes one of the team's verified domains with username as the local part, under its own rules", async () => {
    const teamId = await team("Domain Own");
    await settle(teamId);
    const own = await domainOf(teamId, "own.example.com");
    // On its own domain a team may use a name the shared domain reserves, unreviewed.
    const { review, asked } = reviewer(["postmaster"]);
    const created = await create(
      teamId,
      { domain_id: own.toUpperCase(), username: " Postmaster " },
      { ...deps, judgeSharedNames: review },
    );
    expect(created.ok && created.inbox).toMatchObject({
      email_address: "postmaster@own.example.com",
      domain_id: own,
      shared: false,
    });
    expect(asked).toEqual([]);
    const sendOnly = await domainOf(teamId, "send.example.com", { receivingEnabled: false });
    const notReceiving = await create(teamId, { domain_id: sendOnly, username: "bot" });
    expect(notReceiving.ok ? null : notReceiving.error.message).toMatch(
      /^Turn on receiving for send\.example\.com first/,
    );
    const badLocal = await create(teamId, { domain_id: own, username: "a..b" });
    expect(badLocal.ok ? null : badLocal.error.message).toMatch(/^email_address must be/);
  });

  it("refuses an own domain without username, domain_id with email_address, and anything not the team's", async () => {
    const teamId = await team("Domain Refusals");
    await settle(teamId);
    const own = await domainOf(teamId, "refusals.example.com");
    const unverified = await domainOf(teamId, "pending-dns.example.com", { status: "pending" });
    const stranger = await team("Domain Stranger");
    await settle(stranger);
    const theirs = await domainOf(stranger, "theirs.example.com");
    const theirLabel = (await teamSharedDomain(db, stranger))?.id ?? "";
    const message = async (input: Parameters<typeof create>[1]) => {
      const result = await create(teamId, input);
      return result.ok ? null : result.error.message;
    };
    expect(await message({ domain_id: own })).toBe(
      "domain_id of one of your domains needs username: the part before the @",
    );
    expect(await message({ domain_id: own, email_address: "x@refusals.example.com" })).toBe(
      "Send domain_id or email_address, not both",
    );
    for (const domainId of [theirs, theirLabel, unverified, randomUUID(), "not-a-uuid"]) {
      expect(await message({ domain_id: domainId, username: "bot" }), domainId).toBe(
        "domain_id must be a verified domain of this team: the id of a GET /domains row",
      );
    }
  });

  it("keeps a domain-scoped key off the shared subdomain id", async () => {
    const teamId = await team("Domain Scoped");
    await settle(teamId);
    const own = await domainOf(teamId, "scoped.example.com");
    const sub = await teamSharedDomain(db, teamId);
    const shared = await create(teamId, { domain_id: sub?.id }, deps, own);
    expect(shared.ok ? null : shared.error).toMatchObject({
      status: 403,
      name: "restricted_api_key",
    });
    const onIts = await create(teamId, { domain_id: own, username: "bot" }, deps, own);
    expect(onIts.ok && onIts.inbox.email_address).toBe("bot@scoped.example.com");
  });
});
