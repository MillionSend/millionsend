import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MIGRATION_LOCK_ID, migrateLocked, migrationsFolder } from "../src/migrate.js";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  client = new PGlite();
  db = drizzle(client);
});

afterEach(async () => {
  await client.close();
});

async function lockIsFree(): Promise<boolean> {
  const { rows } = await client.query<{ free: boolean }>(
    "select pg_try_advisory_lock($1) as free",
    [MIGRATION_LOCK_ID],
  );
  if (rows[0]?.free) await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  return rows[0]?.free ?? false;
}

it("is idempotent across sequential runs and releases the lock", async () => {
  const run = () => migrate(db, { migrationsFolder });
  await migrateLocked(db, run);
  await migrateLocked(db, run);
  // Real schema landed exactly once.
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from teams");
  expect(rows[0]?.n).toBe(0);
  expect(await lockIsFree()).toBe(true);
});

it("installs the append-only audit-log trigger in the baseline", async () => {
  await migrateLocked(db, () => migrate(db, { migrationsFolder }));
  await client.query("insert into audit_log (action) values ('baseline-test')");

  await expect(client.query("update audit_log set action = 'mutated'")).rejects.toThrow(
    "audit_log is append-only",
  );
  await expect(client.query("delete from audit_log")).rejects.toThrow("audit_log is append-only");
});

it("releases the lock when the migration itself fails", async () => {
  await expect(
    migrateLocked(db, async () => {
      await db.execute(sql`select boom`);
    }),
  ).rejects.toThrow();
  expect(await lockIsFree()).toBe(true);
});
