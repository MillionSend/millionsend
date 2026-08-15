import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, gte, ilike, isNull, or, type SQL, sql } from "drizzle-orm";
import { type CsvColumn, toCsv } from "@/lib/csv-export";
import { escapeLike } from "@/lib/sql";

/**
 * ponytail: hard row cap instead of a streamed cursor. An export past this
 * many rows is truncated (newest first); swap to a keyset stream if teams
 * routinely export more.
 */
export const EXPORT_ROW_CAP = 50_000;

interface ContactExportRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  unsubscribed: boolean;
  createdAt: Date;
  properties: Record<string, string>;
}

/**
 * Contacts of one audience, teamId-scoped. teamId AND audienceId both gate the
 * query and contacts.teamId is denormalized, so a cross-team audienceId
 * matches no rows — it can never leak another team's contacts.
 */
export function contactRowsForExport(
  db: Db,
  teamId: string,
  filters: { audienceId: string; search?: string },
): Promise<ContactExportRow[]> {
  const t = schema.contacts;
  const conds: SQL[] = [eq(t.teamId, teamId), eq(t.audienceId, filters.audienceId)];
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    const match = or(
      ilike(t.email, pattern),
      ilike(t.firstName, pattern),
      ilike(t.lastName, pattern),
    );
    if (match) conds.push(match);
  }
  return db
    .select({
      email: t.email,
      firstName: t.firstName,
      lastName: t.lastName,
      unsubscribed: t.unsubscribed,
      createdAt: t.createdAt,
      properties: t.properties,
    })
    .from(t)
    .where(and(...conds))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(EXPORT_ROW_CAP);
}

/** Fixed columns plus one column per distinct custom property key in the set. */
export function contactColumns(rows: readonly ContactExportRow[]): CsvColumn<ContactExportRow>[] {
  const propertyKeys = [...new Set(rows.flatMap((r) => Object.keys(r.properties)))].sort();
  return [
    { header: "email", value: (r) => r.email },
    { header: "first_name", value: (r) => r.firstName },
    { header: "last_name", value: (r) => r.lastName },
    { header: "unsubscribed", value: (r) => r.unsubscribed },
    { header: "created_at", value: (r) => r.createdAt },
    ...propertyKeys.map((key) => ({
      header: key,
      value: (r: ContactExportRow) => r.properties[key] ?? "",
    })),
  ];
}

interface EmailExportRow {
  to: string[];
  subject: string;
  latestStatus: string;
  createdAt: Date;
}

export function emailRowsForExport(
  db: Db,
  teamId: string,
  filters: { status?: string; search?: string; apiKeyId?: string; since?: Date },
): Promise<EmailExportRow[]> {
  const t = schema.emails;
  const conds: SQL[] = [eq(t.teamId, teamId)];
  const status = schema.emailStatusEnum.enumValues.find((s) => s === filters.status);
  if (status) conds.push(eq(t.latestStatus, status));
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    const match = or(ilike(t.subject, pattern), sql`${t.to}::text ilike ${pattern}`);
    if (match) conds.push(match);
  }
  if (filters.apiKeyId) conds.push(eq(t.apiKeyId, filters.apiKeyId));
  if (filters.since) conds.push(gte(t.createdAt, filters.since));
  return db
    .select({
      to: t.to,
      subject: t.subject,
      latestStatus: t.latestStatus,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(...conds))
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(EXPORT_ROW_CAP);
}

const emailColumns: CsvColumn<EmailExportRow>[] = [
  { header: "to", value: (r) => r.to.join(", ") },
  { header: "subject", value: (r) => r.subject },
  { header: "status", value: (r) => r.latestStatus },
  { header: "created_at", value: (r) => r.createdAt },
];

interface DomainExportRow {
  name: string;
  region: string;
  status: string;
  createdAt: Date;
}

export function domainRowsForExport(db: Db, teamId: string): Promise<DomainExportRow[]> {
  const d = schema.domains;
  return db
    .select({ name: d.name, region: d.region, status: d.status, createdAt: d.createdAt })
    .from(d)
    .where(eq(d.teamId, teamId))
    .orderBy(desc(d.createdAt));
}

const domainColumns: CsvColumn<DomainExportRow>[] = [
  { header: "domain", value: (r) => r.name },
  { header: "region", value: (r) => r.region },
  { header: "status", value: (r) => r.status },
  { header: "created_at", value: (r) => r.createdAt },
];

interface ApiKeyExportRow {
  name: string;
  tokenPrefix: string;
  last4: string;
  permission: string;
  domainName: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** Active keys only. Never exports keyHash — only the prefix/last4 the UI shows. */
export function apiKeyRowsForExport(db: Db, teamId: string): Promise<ApiKeyExportRow[]> {
  const k = schema.apiKeys;
  return db
    .select({
      name: k.name,
      tokenPrefix: k.tokenPrefix,
      last4: k.last4,
      permission: k.permission,
      domainName: schema.domains.name,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    })
    .from(k)
    .leftJoin(schema.domains, eq(k.domainId, schema.domains.id))
    .where(and(eq(k.teamId, teamId), isNull(k.revokedAt)))
    .orderBy(desc(k.createdAt));
}

const apiKeyColumns: CsvColumn<ApiKeyExportRow>[] = [
  { header: "name", value: (r) => r.name },
  { header: "token_prefix", value: (r) => r.tokenPrefix },
  { header: "last4", value: (r) => r.last4 },
  { header: "permission", value: (r) => r.permission },
  { header: "domain", value: (r) => r.domainName },
  { header: "last_used_at", value: (r) => r.lastUsedAt },
  { header: "created_at", value: (r) => r.createdAt },
];

/**
 * Builds one export's filename + CSV body from the request's query params.
 * Every branch is teamId-scoped; returns null for an unknown resource.
 */
export async function buildExport(
  db: Db,
  teamId: string,
  resource: string,
  params: URLSearchParams,
): Promise<{ filename: string; csv: string } | null> {
  switch (resource) {
    case "contacts": {
      const audienceId = params.get("audienceId");
      if (!audienceId) return null;
      const search = params.get("search") ?? undefined;
      const rows = await contactRowsForExport(db, teamId, {
        audienceId,
        ...(search ? { search } : {}),
      });
      return { filename: "contacts.csv", csv: toCsv(rows, contactColumns(rows), { bom: true }) };
    }
    case "emails": {
      const status = params.get("status") ?? undefined;
      const search = params.get("search") ?? undefined;
      const apiKeyId = params.get("apiKeyId") ?? undefined;
      const sinceRaw = params.get("since");
      const since = sinceRaw ? new Date(sinceRaw) : undefined;
      const rows = await emailRowsForExport(db, teamId, {
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
        ...(apiKeyId ? { apiKeyId } : {}),
        ...(since && !Number.isNaN(since.getTime()) ? { since } : {}),
      });
      return { filename: "emails.csv", csv: toCsv(rows, emailColumns, { bom: true }) };
    }
    case "domains": {
      const rows = await domainRowsForExport(db, teamId);
      return { filename: "domains.csv", csv: toCsv(rows, domainColumns, { bom: true }) };
    }
    case "api-keys": {
      const rows = await apiKeyRowsForExport(db, teamId);
      return { filename: "api-keys.csv", csv: toCsv(rows, apiKeyColumns, { bom: true }) };
    }
    default:
      return null;
  }
}
