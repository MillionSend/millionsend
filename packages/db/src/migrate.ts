import { fileURLToPath, pathToFileURL } from "node:url";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Resolved from this file's location so the script works from any cwd.
export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// Arbitrary constant naming this app's migration critical section.
export const MIGRATION_LOCK_ID = 727_515_368_400_113;

/**
 * Serializes concurrent migrators. drizzle's migrator takes NO lock of its
 * own — it check-then-runs against the migrations table — so two services
 * booting together (e.g. the web and smtp compose services) would race the
 * same DDL. The session-level advisory lock makes the loser wait until the
 * winner commits, after which its own migrate() sees the recorded migrations
 * and no-ops. Lock, migrate, and unlock must share one session, so callers
 * must hand in a single-connection db.
 */
export async function migrateLocked(
  db: { execute: (query: SQL) => Promise<unknown> },
  run: () => Promise<void>,
): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);
  try {
    await run();
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
  }
}

// CLI entry (pnpm db:migrate); guarded so importing migrateLocked runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Reads DATABASE_URL directly instead of @millionsend/config: migrations run
  // before (and independently of) app boot, and must not demand the full app
  // environment (e.g. MASTER_ENCRYPTION_KEY) just to apply DDL.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("db:migrate: DATABASE_URL is not set");
    process.exit(1);
  }

  // max: 1 — the advisory lock is session-scoped; a pool could migrate on a
  // different connection than the one holding the lock.
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  try {
    await migrateLocked(db, () => migrate(db, { migrationsFolder }));
    console.log("db:migrate: migrations applied");
  } catch (error) {
    console.error("db:migrate: failed");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
