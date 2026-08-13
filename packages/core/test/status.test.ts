import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStatusCas } from "../src/status.js";
import { createTeam, createTestDb } from "./helpers/test-db.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

async function createEmail(): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({ teamId, from: "a@b.c", to: ["x@y.z"], subject: "s" })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db
    .select({ s: schema.emails.latestStatus })
    .from(schema.emails)
    .where(eq(schema.emails.id, id));
  return row?.s ?? "missing";
}

describe("status compare-and-set", () => {
  it("advances forward and records the highest status", async () => {
    const id = await createEmail();
    expect(await applyStatusCas(db, id, "sent")).toBe(true);
    expect(await applyStatusCas(db, id, "delivered")).toBe(true);
    expect(await statusOf(id)).toBe("delivered");
  });

  it("ignores out-of-order lower-ranked events", async () => {
    const id = await createEmail();
    await applyStatusCas(db, id, "delivered");
    expect(await applyStatusCas(db, id, "sent")).toBe(false);
    expect(await statusOf(id)).toBe("delivered");
  });

  it("keeps failed terminal: nothing outranks it", async () => {
    const id = await createEmail();
    await applyStatusCas(db, id, "failed");
    expect(await applyStatusCas(db, id, "delivered")).toBe(false);
    expect(await statusOf(id)).toBe("failed");
  });

  it("lets bounce outrank delivered (post-delivery bounce reports)", async () => {
    const id = await createEmail();
    await applyStatusCas(db, id, "delivered");
    expect(await applyStatusCas(db, id, "bounced")).toBe(true);
    expect(await statusOf(id)).toBe("bounced");
  });
});
