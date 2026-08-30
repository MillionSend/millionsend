import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toCsv } from "@/lib/csv-export";
import { buildExport, contactColumns, contactRowsForExport } from "@/server/exports";
import { createCaller } from "@/server/routers";

const endsWith = (value: string) => ({
  match: "all" as const,
  conditions: [{ field: "email", op: "ends_with", value }],
});

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function callerFor(teamId: string) {
  return createCaller({
    db,
    // A fresh session row: api key creation is gated on session age.
    session: {
      user: { id: "u1", email: "u1@example.com", name: "u1" },
      session: { id: "s1", createdAt: new Date() },
    },
    teamId,
    role: "owner",
  });
}

describe("contact export", () => {
  it("returns the expected columns scoped to the team", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({
      email: "a@example.com",
      firstName: "Ada",
      properties: { plan: "pro" },
    });
    const { id: unsub } = await caller.audience.contacts.add({ email: "b@example.com" });
    await caller.audience.contacts.update({ id: unsub, unsubscribed: true });

    const rows = await contactRowsForExport(db, teamId, {});
    expect(rows).toHaveLength(2);

    const headers = contactColumns(rows).map((c) => c.header);
    expect(headers).toEqual([
      "email",
      "first_name",
      "last_name",
      "unsubscribed",
      "created_at",
      // Distinct custom-property key becomes its own column.
      "plan",
    ]);

    const csv = toCsv(rows, contactColumns(rows));
    expect(csv).toContain("a@example.com");
    expect(csv).toContain("Ada");
    expect(csv).toContain("pro");
  });

  it("honors the search filter", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "match@example.com" });
    await caller.audience.contacts.add({ email: "other@example.com" });

    const rows = await contactRowsForExport(db, teamId, { search: "match" });
    expect(rows.map((r) => r.email)).toEqual(["match@example.com"]);
  });

  it("never exports another team's contacts", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await callerFor(teamA).audience.contacts.add({ email: "a@example.com" });

    // The caller's team is B — the teamId gate returns no rows.
    const leaked = await contactRowsForExport(db, teamB, {});
    expect(leaked).toEqual([]);
  });
});

describe("buildExport dispatch", () => {
  it("returns null for an unknown resource", async () => {
    const teamId = await createTeam(db, "team-a");
    expect(await buildExport(db, teamId, "nope", new URLSearchParams())).toBeNull();
  });

  it("builds a whole-team contacts export with no params", async () => {
    const teamId = await createTeam(db, "team-a");
    await callerFor(teamId).audience.contacts.add({ email: "a@example.com" });
    const result = await buildExport(db, teamId, "contacts", new URLSearchParams());
    expect(result?.filename).toBe("contacts.csv");
    expect(result?.csv).toContain("a@example.com");
  });

  it("builds a scoped api-keys export without leaking the full secret", async () => {
    const teamId = await createTeam(db, "team-a");
    const { token } = await callerFor(teamId).apiKeys.create({ name: "Production" });
    const result = await buildExport(db, teamId, "api-keys", new URLSearchParams());
    expect(result?.filename).toBe("api-keys.csv");
    expect(result?.csv).toContain("Production");
    // Only the shown prefix/last4 are exported — never the plaintext token.
    expect(result?.csv).not.toContain(token);
  });
});

describe("contact export with segment and topic filters", () => {
  it("exports exactly the segment's contacts, matching the live filtered count", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "keep@x.com" });
    await caller.audience.contacts.add({ email: "drop@y.com" });
    const { id: segmentId } = await caller.segments.create({
      name: "X domain",
      filter: endsWith("@x.com"),
    });

    const rows = await contactRowsForExport(db, teamId, { segmentId });
    expect(rows.map((r) => r.email)).toEqual(["keep@x.com"]);
    // The export and the on-screen list agree on the row count.
    const listed = await caller.audience.contacts.list({ segmentId });
    expect(listed.total).toBe(rows.length);
  });

  it("exports only contacts subscribed to the topic", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: inId } = await caller.audience.contacts.add({ email: "in@x.com" });
    const { id: outId } = await caller.audience.contacts.add({ email: "out@x.com" });
    await caller.audience.contacts.add({ email: "absent@x.com" });
    // Opt-out topic: only an explicit subscribed=true row is a member.
    const { id: topicId } = await caller.topics.create({
      name: "Digest",
      defaultSubscribed: false,
    });
    await db.insert(schema.contactTopicSubscriptions).values([
      { contactId: inId, topicId, subscribed: true },
      { contactId: outId, topicId, subscribed: false },
    ]);

    const rows = await contactRowsForExport(db, teamId, { topicId });
    expect(rows.map((r) => r.email)).toEqual(["in@x.com"]);
  });

  it("yields no rows for a foreign or unknown segment/topic", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const callerA = callerFor(teamA);
    const callerB = callerFor(teamB);
    await callerA.audience.contacts.add({ email: "a@x.com" });
    const { id: segmentA } = await callerA.segments.create({
      name: "all",
      filter: { match: "all", conditions: [] },
    });
    const { id: topicB } = await callerB.topics.create({ name: "T", defaultSubscribed: true });

    // Team B asking for team A's segment → shared guard rejects → no rows.
    expect(await contactRowsForExport(db, teamB, { segmentId: segmentA })).toEqual([]);
    // Team A asking for team B's topic → shared guard rejects → no rows.
    expect(await contactRowsForExport(db, teamA, { topicId: topicB })).toEqual([]);
    // A wholly unknown id likewise yields nothing rather than every contact.
    expect(await contactRowsForExport(db, teamA, { segmentId: randomUUID() })).toEqual([]);
  });

  it("still neutralizes a formula payload in a segment-filtered export", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    // Direct insert: the formula lives in a stored field, not user add() input.
    await db.insert(schema.contacts).values({
      teamId,
      email: "evil@x.com",
      firstName: "=cmd()",
      properties: {},
    });
    const { id: segmentId } = await caller.segments.create({
      name: "X",
      filter: endsWith("@x.com"),
    });

    const rows = await contactRowsForExport(db, teamId, { segmentId });
    const csv = toCsv(rows, contactColumns(rows), { bom: true });
    // The guard prefixes a quote so the cell is never a live spreadsheet formula.
    expect(csv).toContain("'=cmd()");
  });
});

describe("buildExport carries the segment/topic query params", () => {
  it("applies segmentId from the query string, mirroring the export link", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "keep@x.com" });
    await caller.audience.contacts.add({ email: "drop@y.com" });
    const { id: segmentId } = await caller.segments.create({
      name: "X",
      filter: endsWith("@x.com"),
    });

    const params = new URLSearchParams({ segmentId });
    const result = await buildExport(db, teamId, "contacts", params);
    expect(result?.csv).toContain("keep@x.com");
    expect(result?.csv).not.toContain("drop@y.com");
  });

  it("ignores a non-uuid segment param instead of erroring", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "a@x.com" });

    const params = new URLSearchParams({ segmentId: "not-a-uuid" });
    const result = await buildExport(db, teamId, "contacts", params);
    // The bad param is dropped; the team still exports normally.
    expect(result?.csv).toContain("a@x.com");
  });
});
