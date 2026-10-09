import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";
import LinkifyIt from "linkify-it";
import { find } from "linkifyjs";

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

/**
 * Customer-typed names shaped like phishing lures: a link, an address, a bare
 * domain, look-alike dots, zero-width and bidi tricks, line breaks and
 * overlong text, each built around a domain the auto-linkers recognise.
 */
export const LURE_NAMES = [
  "Your account is locked, visit acme-support.com",
  "https://acme-support.com/login",
  "www.acme-support.com",
  "mailto:billing@acme-support.com",
  "Write to billing@acme-support.com",
  "acme-support.com",
  "acme-support\u3002com",
  "\uff41\uff43\uff4d\uff45-support\uff0ecom",
  "acme-support\u2024com",
  "acme-sup\u200bport.com",
  "\u202emoc.troppus-emca\u202c",
  "Security notice\nVisit acme-support.com\n\nThe MillionSend team",
  `${"Urgent: verify your account now. ".repeat(3)}acme-support.com`,
] as const;

/**
 * Names every team and display name input refuses: a URL scheme, an
 * address, a zero-width or bidi character, a line break, too long.
 */
export const REFUSED_NAMES = [
  "https://acme-support.com/login",
  "mailto:billing@acme-support.com",
  "Write to billing@acme-support.com",
  "Acme \uff20 support",
  "acme-sup\u200bport",
  "\u202emoc.troppus-emca\u202c",
  "Security notice\nVisit acme-support.com",
  "x".repeat(65),
] as const;

/** Mail text as a reader sees it: the hair spaces that keep customer text from linking left out. */
export function readable(text: string | undefined): string {
  return (text ?? "").replaceAll("\u200a", "");
}

const linkifyIt = new LinkifyIt({ fuzzyIP: true });

/**
 * Every link two independent auto-linkers find in text (linkify-it, which
 * markdown-it and mailparser use, and linkifyjs), on the text as written and
 * as IDNA reads a host: compatibility forms folded, invisible characters gone.
 */
export function autoLinks(text: string): string[] {
  const folded = text
    .normalize("NFKC")
    .replaceAll("\u3002", ".")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "");
  const found = new Set<string>();
  for (const t of [text, folded]) {
    for (const match of linkifyIt.match(t) ?? []) found.add(match.url);
    for (const link of find(t)) found.add(link.href);
  }
  return [...found];
}

/**
 * Every link a mail client could show for a message: the HTML's anchors, and
 * what the auto-linkers find in the subject, the HTML's text and the
 * plain-text part.
 */
export function mailLinks(mail: { subject: string; html: string; text: string }): string[] {
  const htmlText = mail.html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ");
  return [
    ...new Set([
      ...[...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? ""),
      ...autoLinks(mail.subject),
      ...autoLinks(htmlText),
      ...autoLinks(mail.text),
    ]),
  ];
}
