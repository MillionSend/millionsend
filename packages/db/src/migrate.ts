import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Reads DATABASE_URL directly instead of @millionsend/config: migrations run
// before (and independently of) app boot, and must not demand the full app
// environment (e.g. MASTER_ENCRYPTION_KEY) just to apply DDL.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("db:migrate: DATABASE_URL is not set");
  process.exit(1);
}

// Resolved from this file's location so the script works from any cwd.
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// max: 1 — drizzle's migrator takes an advisory lock; a pool would let a
// second connection sidestep it.
const sql = postgres(databaseUrl, { max: 1 });

try {
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("db:migrate: migrations applied");
} catch (error) {
  console.error("db:migrate: failed");
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
