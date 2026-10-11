import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/** What a fingerprint of a team suspended for phishing records. */
export type CampaignFingerprintKind =
  | "display_name"
  | "subject"
  | "sending_domain"
  | "link_domain"
  | "phone"
  | "text_hash"
  | "card"
  | "ip"
  | "address";

/**
 * What a team suspended for phishing left behind, kept at its suspension so
 * new teams can be compared with it. No foreign key on purpose: the
 * fingerprints outlive the team, and its name is kept for the console.
 * Names, subjects and domains are stored as sent; phones, addresses, IPs,
 * cards and the text hash in the normalized form they are compared in.
 */
export const campaignFingerprints = pgTable(
  "campaign_fingerprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    teamName: text("team_name").notNull(),
    kind: text("kind").$type<CampaignFingerprintKind>().notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("campaign_fingerprints_team_kind_value_idx").on(t.teamId, t.kind, t.value)],
);

/** One fingerprint a team shares with a team suspended for phishing: the team's own value and the one it matched. */
export interface LinkMatch {
  kind: CampaignFingerprintKind;
  value: string;
  matched: string;
}

export type LinkTrigger = "team" | "domain" | "payment" | "send";

/**
 * A team found to match a team suspended for phishing, one row per pair.
 * Linkage acts on a team once: a team an operator released is not held
 * again for the same evidence or for new evidence.
 */
export const teamLinks = pgTable(
  "team_links",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    linkedTeamId: uuid("linked_team_id").notNull(),
    linkedTeamName: text("linked_team_name").notNull(),
    matches: jsonb("matches").$type<LinkMatch[]>().notNull(),
    trigger: text("trigger").$type<LinkTrigger>().notNull(),
    // Whether this link put the review hold on the team.
    held: boolean("held").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // When the worker mailed the operator about it.
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.linkedTeamId] }),
    index("team_links_unalerted_idx").on(t.createdAt).where(sql`${t.alertedAt} is null`),
  ],
);
