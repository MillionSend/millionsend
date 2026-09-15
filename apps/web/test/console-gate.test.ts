import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type ConsoleGateDeps, consoleOperator } from "@/server/console-gate";

let db: Db;
let close: () => Promise<void>;

const first = { id: "op", email: "op@example.com", name: "Operator" };
const later = { id: "later", email: "later@example.com", name: "Later" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { ...first, createdAt: new Date(0) },
    { ...later, createdAt: new Date(1) },
  ]);
});
afterAll(() => close());

const deps = (user: typeof first | null): ConsoleGateDeps => ({
  session: async () => (user ? { user } : null),
  db: () => db,
});

it("returns the first registered user", async () => {
  expect(await consoleOperator(new Headers(), deps(first))).toEqual(first);
});

it("returns null for a later user", async () => {
  expect(await consoleOperator(new Headers(), deps(later))).toBeNull();
});

it("returns null without a session", async () => {
  expect(await consoleOperator(new Headers(), deps(null))).toBeNull();
});
