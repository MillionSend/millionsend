import { env } from "@millionsend/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

// prepare:false keeps the client compatible with transaction-mode poolers (PgBouncer).
const sql = postgres(env.DATABASE_URL, { prepare: false });

export const db = drizzle(sql, { schema });

export type Db = typeof db;
