import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../db/drizzle");

/**
 * Fresh in-memory Postgres with the real generated migrations applied —
 * tests exercise the same DDL production runs, append-only trigger included.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const statements = readFileSync(join(migrationsDir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await client.exec(statement);
    }
  }
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.close() };
}

export async function createTeam(db: Db, slug = "acme"): Promise<string> {
  const [team] = await db
    .insert(schema.teams)
    .values({ name: slug, slug })
    .returning({ id: schema.teams.id });
  if (!team) throw new Error("team insert failed");
  return team.id;
}

/**
 * An enabled webhook endpoint for fan-out tests. The secret columns hold a
 * placeholder byte: enqueueing reads only id, events, teamId and status.
 */
export async function createWebhookEndpoint(
  db: Db,
  teamId: string,
  events: string[] | null,
): Promise<string> {
  const dummy = Buffer.alloc(1);
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hook.example.com/in",
      secretCiphertext: dummy,
      secretIv: dummy,
      secretWrappedDek: dummy,
      secretKeyVersion: 1,
      secretLast4: "abcd",
      events,
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!row) throw new Error("webhook endpoint insert failed");
  return row.id;
}
