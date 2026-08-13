import { env } from "@millionsend/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;

function createDb() {
  // prepare:false keeps the client compatible with transaction-mode poolers (PgBouncer).
  const sql = postgres(env.DATABASE_URL, { prepare: false });
  return drizzle(sql, { schema });
}

let instance: Db | undefined;

/**
 * Lazy singleton: importing the package (e.g. for schema types in tests or
 * scripts) must not construct a connection pool or require DATABASE_URL.
 */
export function getDb(): Db {
  instance ??= createDb();
  return instance;
}
