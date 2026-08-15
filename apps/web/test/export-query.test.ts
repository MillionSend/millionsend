import type { Db } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toCsv } from "@/lib/csv-export";
import { buildExport, contactColumns, contactRowsForExport } from "@/server/exports";
import { createCaller } from "@/server/routers";

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
