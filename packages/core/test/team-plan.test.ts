import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactRoom } from "../src/team-plan.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

const addContacts = (from: number, n: number) =>
  db
    .insert(schema.contacts)
    .values(Array.from({ length: n }, (_, i) => ({ teamId, email: `c${from + i}@example.com` })));

describe("contactRoom", () => {
  it("is what is left under the Free cap, down to zero", async () => {
    await addContacts(0, 998);
    expect(await contactRoom(db, teamId, "free", true)).toBe(2);
    await addContacts(998, 2);
    expect(await contactRoom(db, teamId, "free", true)).toBe(0);
  });

  it("caps nothing on an uncapped plan or off Cloud", async () => {
    expect(await contactRoom(db, teamId, "pro", true)).toBeNull();
    expect(await contactRoom(db, teamId, "free", false)).toBeNull();
  });
});
