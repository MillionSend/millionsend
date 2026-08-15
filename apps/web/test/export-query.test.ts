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
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  });
}

describe("contact export", () => {
  it("returns the expected columns scoped to the audience", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.add({
      audienceId,
      email: "a@example.com",
      firstName: "Ada",
      properties: { plan: "pro" },
    });
    const { id: unsub } = await caller.audience.contacts.add({
      audienceId,
      email: "b@example.com",
    });
    await caller.audience.contacts.update({ id: unsub, unsubscribed: true });

    const rows = await contactRowsForExport(db, teamId, { audienceId });
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    await caller.audience.contacts.add({ audienceId, email: "match@example.com" });
    await caller.audience.contacts.add({ audienceId, email: "other@example.com" });

    const rows = await contactRowsForExport(db, teamId, { audienceId, search: "match" });
    expect(rows.map((r) => r.email)).toEqual(["match@example.com"]);
  });

  it("yields nothing for another team's audience id", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { id: audienceId } = await callerFor(teamA).audience.audiences.create({ name: "A" });
    await callerFor(teamA).audience.contacts.add({ audienceId, email: "a@example.com" });

    // Same audience id, but the caller's team is B — the teamId gate returns no rows.
    const leaked = await contactRowsForExport(db, teamB, { audienceId });
    expect(leaked).toEqual([]);
  });
});

describe("buildExport dispatch", () => {
  it("returns null for an unknown resource", async () => {
    const teamId = await createTeam(db, "team-a");
    expect(await buildExport(db, teamId, "nope", new URLSearchParams())).toBeNull();
  });

  it("returns null when contacts export omits the audience id", async () => {
    const teamId = await createTeam(db, "team-a");
    expect(await buildExport(db, teamId, "contacts", new URLSearchParams())).toBeNull();
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    await caller.audience.contacts.add({ audienceId, email: "keep@x.com" });
    await caller.audience.contacts.add({ audienceId, email: "drop@y.com" });
    const { id: segmentId } = await caller.segments.create({
      audienceId,
      name: "X domain",
      filter: endsWith("@x.com"),
    });

    const rows = await contactRowsForExport(db, teamId, { audienceId, segmentId });
    expect(rows.map((r) => r.email)).toEqual(["keep@x.com"]);
    // The export and the on-screen list agree on the row count.
    const listed = await caller.audience.contacts.list({ audienceId, segmentId });
    expect(listed.total).toBe(rows.length);
  });

  it("exports only contacts subscribed to the topic", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    const { id: inId } = await caller.audience.contacts.add({ audienceId, email: "in@x.com" });
    const { id: outId } = await caller.audience.contacts.add({ audienceId, email: "out@x.com" });
    await caller.audience.contacts.add({ audienceId, email: "absent@x.com" });
    // Opt-out topic: only an explicit subscribed=true row is a member.
    const { id: topicId } = await caller.topics.create({
      name: "Digest",
      defaultSubscribed: false,
    });
    await db.insert(schema.contactTopicSubscriptions).values([
      { contactId: inId, topicId, subscribed: true },
      { contactId: outId, topicId, subscribed: false },
    ]);

    const rows = await contactRowsForExport(db, teamId, { audienceId, topicId });
    expect(rows.map((r) => r.email)).toEqual(["in@x.com"]);
  });

  it("yields no rows for a foreign or unknown segment/topic", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const callerA = callerFor(teamA);
    const callerB = callerFor(teamB);
    const { id: audienceA } = await callerA.audience.audiences.create({ name: "A" });
    await callerA.audience.contacts.add({ audienceId: audienceA, email: "a@x.com" });
    const { id: segmentA } = await callerA.segments.create({
      audienceId: audienceA,
      name: "all",
      filter: { match: "all", conditions: [] },
    });
    const { id: topicB } = await callerB.topics.create({ name: "T", defaultSubscribed: true });

    // Team B asking for team A's segment → shared guard rejects → no rows.
    expect(
      await contactRowsForExport(db, teamB, { audienceId: audienceA, segmentId: segmentA }),
    ).toEqual([]);
    // Team A asking for team B's topic → shared guard rejects → no rows.
    expect(
      await contactRowsForExport(db, teamA, { audienceId: audienceA, topicId: topicB }),
    ).toEqual([]);
    // A wholly unknown id likewise yields nothing rather than the whole audience.
    expect(
      await contactRowsForExport(db, teamA, { audienceId: audienceA, segmentId: randomUUID() }),
    ).toEqual([]);
  });

  it("still neutralizes a formula payload in a segment-filtered export", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    // Direct insert: the formula lives in a stored field, not user add() input.
    await db.insert(schema.contacts).values({
      teamId,
      audienceId,
      email: "evil@x.com",
      firstName: "=cmd()",
      properties: {},
    });
    const { id: segmentId } = await caller.segments.create({
      audienceId,
      name: "X",
      filter: endsWith("@x.com"),
    });

    const rows = await contactRowsForExport(db, teamId, { audienceId, segmentId });
    const csv = toCsv(rows, contactColumns(rows), { bom: true });
    // The guard prefixes a quote so the cell is never a live spreadsheet formula.
    expect(csv).toContain("'=cmd()");
  });
});

describe("buildExport carries the segment/topic query params", () => {
  it("applies segmentId from the query string, mirroring the export link", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    await caller.audience.contacts.add({ audienceId, email: "keep@x.com" });
    await caller.audience.contacts.add({ audienceId, email: "drop@y.com" });
    const { id: segmentId } = await caller.segments.create({
      audienceId,
      name: "X",
      filter: endsWith("@x.com"),
    });

    const params = new URLSearchParams({ audienceId, segmentId });
    const result = await buildExport(db, teamId, "contacts", params);
    expect(result?.csv).toContain("keep@x.com");
    expect(result?.csv).not.toContain("drop@y.com");
  });

  it("ignores a non-uuid segment param instead of erroring", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    await caller.audience.contacts.add({ audienceId, email: "a@x.com" });

    const params = new URLSearchParams({ audienceId, segmentId: "not-a-uuid" });
    const result = await buildExport(db, teamId, "contacts", params);
    // The bad param is dropped; the audience still exports normally.
    expect(result?.csv).toContain("a@x.com");
  });
});
