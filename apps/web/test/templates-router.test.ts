import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

vi.mock("@millionsend/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@millionsend/db")>();
  return { ...mod, getDb: () => db };
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

const TEMPLATE_INPUT = {
  name: "Welcome",
  subject: "Hello {{{FIRST_NAME|there}}}",
  html: "<p>Hi {{{FIRST_NAME|there}}}</p>",
  text: "Hi {{{FIRST_NAME|there}}}",
};

const SAMPLE_DOC = {
  version: 1 as const,
  blocks: [
    {
      type: "text" as const,
      id: "b1",
      html: "<p>Hi {{{FIRST_NAME|there}}}</p>",
      align: "left" as const,
      color: "#111111",
      fontSize: 16,
      padding: 12,
    },
  ],
};

async function templateRow(id: string) {
  const [row] = await db.select().from(schema.templates).where(eq(schema.templates.id, id));
  return row ?? null;
}

describe("templates.create / get / update / delete", () => {
  it("round-trips a template through create, get, and update", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);

    const { id } = await caller.templates.create(TEMPLATE_INPUT);
    expect(await caller.templates.get({ id })).toMatchObject({ id, teamId, ...TEMPLATE_INPUT });

    await caller.templates.update({ id, name: "Welcome v2", subject: "" });
    // "" clears nullable fields — stored as null, never as an empty string.
    expect(await templateRow(id)).toMatchObject({ name: "Welcome v2", subject: null });
  });

  it("stores omitted optional fields as null", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.templates.create({ name: "Bare", html: "<p>x</p>" });
    expect(await templateRow(id)).toMatchObject({ subject: null, text: null });
  });

  it("deletes a template", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.templates.create(TEMPLATE_INPUT);
    await caller.templates.delete({ id });
    expect(await templateRow(id)).toBeNull();
  });
});

describe("templates.duplicate", () => {
  it('inserts an independent copy named "<name> (copy)"', async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.templates.create(TEMPLATE_INPUT);

    const { id: copyId } = await caller.templates.duplicate({ id });
    expect(copyId).not.toBe(id);
    expect(await caller.templates.get({ id: copyId })).toMatchObject({
      ...TEMPLATE_INPUT,
      name: "Welcome (copy)",
      teamId,
    });

    // Independent rows: editing the copy leaves the original alone.
    await caller.templates.update({ id: copyId, html: "<p>changed</p>" });
    expect((await templateRow(id))?.html).toBe(TEMPLATE_INPUT.html);
  });
});

describe("templates.list keyset paging", () => {
  it("pages on (updatedAt, id) desc without duplicates, most recently updated first", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await caller.templates.create({ name: `t${i}`, html: "<p>x</p>" });
      ids.push(id);
    }
    const oldest = ids[0];
    if (!oldest) throw new Error("expected a created template id");
    // Distinct updatedAt so the recency ordering itself is observable. The
    // gap is stamped directly: inserts default to the DB's microsecond clock
    // while updates carry a millisecond JS Date, so real clocks can order an
    // update BEFORE a same-millisecond insert.
    await caller.templates.update({ id: oldest, name: "t0 edited" });
    await db
      .update(schema.templates)
      .set({ updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.templates.id, oldest));

    const page1 = await caller.templates.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.name).toBe("t0 edited");
    expect(page1.nextCursor).not.toBeNull();
    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller.templates.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const seen = [...page1.items, ...page2.items].map((t) => t.id);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("templates.document", () => {
  it("round-trips a block document through create and get", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.templates.create({ ...TEMPLATE_INPUT, document: SAMPLE_DOC });
    expect((await caller.templates.get({ id })).document).toEqual(SAMPLE_DOC);
    // A legacy row (no document) stays null and still opens.
    const { id: legacyId } = await caller.templates.create(TEMPLATE_INPUT);
    expect((await caller.templates.get({ id: legacyId })).document).toBeNull();
  });

  it("clears the document back to legacy raw-HTML when updated to null", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.templates.create({ ...TEMPLATE_INPUT, document: SAMPLE_DOC });
    await caller.templates.update({ id, document: null });
    expect((await templateRow(id))?.document).toBeNull();
  });

  it("rejects a malformed document via the zod guard", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong shape
      caller.templates.create({ ...TEMPLATE_INPUT, document: { version: 2, blocks: [] } as any }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("tenant isolation", () => {
  it("blocks every cross-team read and write", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { id } = await callerFor(teamA).templates.create(TEMPLATE_INPUT);

    const b = callerFor(teamB);
    await expect(b.templates.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.templates.update({ id, name: "hijack" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.templates.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.templates.duplicate({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // list is scoped, not errored; the template survives all of it.
    expect((await b.templates.list({})).items).toEqual([]);
    expect((await templateRow(id))?.name).toBe(TEMPLATE_INPUT.name);
  });
});
