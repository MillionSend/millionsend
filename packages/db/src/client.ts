import { env } from "@millionsend/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;

/** timestamptz, timestamp, date — the scalar OIDs a Date param can bind to. */
const DATE_OIDS = [1184, 1114, 1082];

function createDb() {
  // prepare:false keeps the client compatible with transaction-mode poolers (PgBouncer).
  const sql = postgres(env.DATABASE_URL, { prepare: false });
  const db = drizzle(sql, { schema });
  // drizzle's postgres-js driver swaps the driver's date serializers for the
  // identity function (column-bound values reach it already mapped to text),
  // so a Date interpolated straight into a raw sql`` template hit the wire
  // encoder unserialized and threw before the query ran. Restore the Date
  // case only: strings must keep passing through untouched, which is what
  // drizzle's override exists for.
  for (const oid of DATE_OIDS) {
    sql.options.serializers[oid] = (value: unknown) =>
      value instanceof Date ? value.toISOString() : value;
  }
  return db;
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
