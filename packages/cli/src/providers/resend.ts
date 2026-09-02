import type { Http, RequestOptions } from "../http.js";
import type { Logger } from "../log.js";
import type {
  DnsRecord,
  Resource,
  Snapshot,
  SourceBroadcast,
  SourceContact,
  SourceDomain,
  SourceMetrics,
  SourceSegment,
  SourceTemplate,
  SourceTemplateVariable,
} from "../model.js";

export const RESEND_BASE_URL = "https://api.resend.com";
/**
 * Overrides the API host (the e2e points it at a fake server). Deliberately
 * not RESEND_BASE_URL: that is what users set in their app to point Resend
 * SDKs at MillionSend, and it must never redirect this tool's Resend key.
 */
export const RESEND_BASE_URL_ENV = "MILLIONSEND_CLI_RESEND_URL";

export const resendBaseUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env[RESEND_BASE_URL_ENV];
  return override === undefined || override === "" ? RESEND_BASE_URL : override;
};

/** Resend's maximum page size; every list is walked with it and an `after` cursor. */
const PAGE = 100;
const METRICS_WINDOW_DAYS = 30;

export interface SourceProgress {
  label: string;
  n: number;
  total?: number | undefined;
  done: boolean;
}
export type OnProgress = (event: SourceProgress) => void;

export interface ReadShallowOptions {
  include: ReadonlySet<Resource>;
  /** Fetch the bodies of sent broadcasts too (they are always listed). */
  includeSent?: boolean | undefined;
  onProgress?: OnProgress | undefined;
}

export interface EnrichOptions {
  /** Contact ids already enriched by an earlier run (resume). */
  alreadyDone?: ReadonlySet<string> | undefined;
  onProgress?: OnProgress | undefined;
  /** Called per enriched contact, in order; awaited so the caller can batch and persist. */
  onContact: (contact: SourceContact) => void | Promise<void>;
}

export interface Source {
  /** Requests made through this source so far. */
  readonly requests: number;
  probe(): Promise<{ ok: true; teamHint?: string | undefined }>;
  readShallow(options: ReadShallowOptions): Promise<Snapshot>;
  enrichContacts(snapshot: Snapshot, options: EnrichOptions): Promise<Snapshot>;
  readMetrics(): Promise<SourceMetrics>;
}

interface ListBody<T> {
  data?: T[] | undefined;
  has_more?: boolean | undefined;
}
interface WireRecord {
  record?: string;
  name?: string;
  type?: string;
  value?: string;
  ttl?: string;
  priority?: number;
  status?: string;
}
interface WireDomain {
  id: string;
  name: string;
  status?: string;
  region?: string;
  open_tracking?: boolean;
  click_tracking?: boolean;
  tracking_subdomain?: string;
  records?: WireRecord[];
}
interface WireApiKey {
  id: string;
  name: string;
  created_at: string;
}
interface WireProperty {
  id: string;
  key: string;
  type?: string;
  fallback_value?: string | number | null;
}
interface WireTopic {
  id: string;
  name: string;
  description?: string | null;
  default_subscription?: "opt_in" | "opt_out";
  visibility?: "public" | "private";
}
interface WireSegment {
  id: string;
  name: string;
  filter?: unknown;
}
interface WireContact {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  unsubscribed?: boolean;
  created_at?: string;
  properties?: Record<string, unknown> | null;
}
interface WireContactTopic {
  id: string;
  subscription?: "opt_in" | "opt_out";
}
interface WireBroadcast {
  id: string;
  name?: string | null;
  status?: string;
  segment_id?: string | null;
  topic_id?: string | null;
  scheduled_at?: string | null;
  from?: string | null;
  subject?: string | null;
  reply_to?: string[] | null;
  preview_text?: string | null;
  html?: string | null;
  text?: string | null;
}
interface WireTemplate {
  id: string;
  name: string;
  alias?: string | null;
  from?: string | null;
  subject?: string | null;
  reply_to?: string[] | null;
  html?: string | null;
  text?: string | null;
  variables?: { key: string; type: string; fallback_value?: unknown }[] | null;
}
interface WireWebhook {
  id: string;
  endpoint: string;
  events?: string[] | null;
  status?: string;
  signing_secret?: string;
}
interface WireSuppression {
  id: string;
  email: string;
  origin?: "bounce" | "complaint" | "manual";
  created_at?: string;
}

const path = (...parts: string[]): string => `/${parts.map(encodeURIComponent).join("/")}`;

/**
 * Resend names records relative to the registered root, so the return-path
 * label is the first one ("send" for example.com, "send.mail" for
 * mail.example.com); anything but the default "send" is a custom return path.
 */
function customReturnPath(records: WireRecord[]): string | null {
  const spf = records.find((record) => record.record === "SPF" && record.name !== undefined);
  const label = spf?.name?.split(".")[0];
  return label === undefined || label === "" || label === "send" ? null : label;
}

function toDomain(wire: WireDomain): SourceDomain {
  const records = wire.records ?? [];
  return {
    name: wire.name,
    region: wire.region ?? "us-east-1",
    openTracking: wire.open_tracking === true,
    clickTracking: wire.click_tracking === true,
    trackingSubdomain: wire.tracking_subdomain ?? null,
    customReturnPath: customReturnPath(records),
    records: records.map(
      (record): DnsRecord => ({
        record: record.record ?? "",
        name: record.name ?? "",
        type: record.type ?? "",
        value: record.value ?? "",
        ttl: record.ttl,
        priority: record.priority,
        status: record.status,
      }),
    ),
    status: wire.status ?? "unknown",
  };
}

function toContact(wire: WireContact): SourceContact {
  return {
    id: wire.id,
    email: wire.email,
    firstName: wire.first_name ?? null,
    lastName: wire.last_name ?? null,
    unsubscribed: wire.unsubscribed === true,
    createdAt: wire.created_at ?? "",
  };
}

function toBroadcast(wire: WireBroadcast): SourceBroadcast {
  return {
    id: wire.id,
    name: wire.name ?? "",
    from: wire.from ?? "",
    subject: wire.subject ?? "",
    replyTo: wire.reply_to ?? null,
    previewText: wire.preview_text ?? null,
    html: wire.html ?? null,
    text: wire.text ?? null,
    status: wire.status ?? "draft",
    segmentId: wire.segment_id ?? null,
    topicId: wire.topic_id ?? null,
    scheduledAt: wire.scheduled_at ?? null,
  };
}

function toVariable(wire: {
  key: string;
  type: string;
  fallback_value?: unknown;
}): SourceTemplateVariable {
  const fallback = wire.fallback_value;
  return {
    key: wire.key,
    type: wire.type,
    fallbackValue:
      fallback === undefined || fallback === null || typeof fallback === "string"
        ? fallback
        : typeof fallback === "number"
          ? fallback
          : JSON.stringify(fallback),
  };
}

function toTemplate(wire: WireTemplate): SourceTemplate {
  return {
    id: wire.id,
    name: wire.name,
    alias: wire.alias ?? null,
    from: wire.from ?? null,
    subject: wire.subject ?? null,
    replyTo: wire.reply_to ?? null,
    html: wire.html ?? null,
    text: wire.text ?? null,
    variables: (wire.variables ?? []).map(toVariable),
  };
}

function toProperties(
  raw: Record<string, unknown> | null | undefined,
): Record<string, string | number> {
  const properties: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === "string" || typeof value === "number") properties[key] = value;
  }
  return properties;
}

const emptySnapshot = (): Snapshot => ({
  provider: "resend",
  takenAt: new Date().toISOString(),
  domains: [],
  apiKeys: [],
  properties: [],
  topics: [],
  segments: [],
  contacts: [],
  broadcasts: [],
  templates: [],
  webhooks: [],
  suppressions: [],
  metrics: { emailsLast30Days: null },
  enriched: false,
});

/** Reads a Resend account into the neutral Snapshot. GET only; `http` must be the read-only client. */
export function createResendSource(http: Http, log: Logger): Source {
  let requests = 0;
  const get = <T>(route: string, options?: RequestOptions) => {
    requests += 1;
    return http.get<T>(route, options);
  };

  async function listAll<T extends { id: string }>(
    route: string,
    query: Record<string, string | undefined> = {},
    label?: string,
    onProgress?: OnProgress,
  ): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;
    for (;;) {
      const { body } = await get<ListBody<T>>(route, { query: { ...query, limit: PAGE, after } });
      const data = body.data ?? [];
      items.push(...data);
      const last = data[data.length - 1];
      const hasMore = body.has_more ?? data.length === PAGE;
      if (!hasMore || last === undefined) break;
      after = last.id;
      if (label !== undefined) onProgress?.({ label, n: items.length, done: false });
    }
    if (label !== undefined) {
      onProgress?.({ label, n: items.length, total: items.length, done: true });
    }
    return items;
  }

  /** List, then GET each item; progress counts the detail fetches against the list length. */
  async function listWithDetails<L extends { id: string }, D>(
    route: string,
    label: string,
    onProgress: OnProgress | undefined,
    detail: (item: L) => Promise<D>,
  ): Promise<D[]> {
    const list = await listAll<L>(route);
    const out: D[] = [];
    for (const item of list) {
      out.push(await detail(item));
      onProgress?.({ label, n: out.length, total: list.length, done: false });
    }
    onProgress?.({ label, n: out.length, total: list.length, done: true });
    return out;
  }

  return {
    get requests() {
      return requests;
    },

    async probe() {
      const { body } = await get<ListBody<WireDomain>>("/domains", { query: { limit: 1 } });
      const first = body.data?.[0];
      return first === undefined ? { ok: true } : { ok: true, teamHint: first.name };
    },

    async readShallow({ include, includeSent = false, onProgress }) {
      const snapshot = emptySnapshot();
      if (include.has("domains")) {
        snapshot.domains = await listWithDetails<WireDomain, SourceDomain>(
          "/domains",
          "Domains",
          onProgress,
          async (item) => toDomain((await get<WireDomain>(path("domains", item.id))).body),
        );
      }
      if (include.has("properties")) {
        const list = await listAll<WireProperty>(
          "/contact-properties",
          {},
          "Contact properties",
          onProgress,
        );
        snapshot.properties = list.map((property) => ({
          key: property.key,
          type: property.type === "number" ? "number" : "string",
          fallbackValue: property.fallback_value,
        }));
      }
      if (include.has("topics")) {
        const list = await listAll<WireTopic>("/topics", {}, "Topics", onProgress);
        snapshot.topics = list.map((topic) => ({
          id: topic.id,
          name: topic.name,
          description: topic.description ?? null,
          defaultSubscription: topic.default_subscription ?? "opt_in",
          visibility: topic.visibility,
        }));
      }
      if (include.has("segments")) {
        snapshot.segments = await listWithDetails<WireSegment, SourceSegment>(
          "/segments",
          "Segments",
          onProgress,
          async (item) => {
            const { body } = await get<WireSegment>(path("segments", item.id));
            const members = await listAll<WireContact>("/contacts", { segment_id: item.id });
            return {
              id: item.id,
              name: body.name ?? item.name,
              filter: body.filter ?? null,
              memberEmails: members.map((member) => member.email),
            };
          },
        );
      }
      if (include.has("contacts")) {
        const list = await listAll<WireContact>("/contacts", {}, "Contacts", onProgress);
        snapshot.contacts = list.map(toContact);
      }
      if (include.has("broadcasts")) {
        snapshot.broadcasts = await listWithDetails<WireBroadcast, SourceBroadcast>(
          "/broadcasts",
          "Broadcasts",
          onProgress,
          async (item) =>
            item.status === "sent" && !includeSent
              ? toBroadcast(item)
              : toBroadcast((await get<WireBroadcast>(path("broadcasts", item.id))).body),
        );
      }
      if (include.has("templates")) {
        snapshot.templates = await listWithDetails<WireTemplate, SourceTemplate>(
          "/templates",
          "Templates",
          onProgress,
          async (item) => toTemplate((await get<WireTemplate>(path("templates", item.id))).body),
        );
      }
      if (include.has("webhooks")) {
        snapshot.webhooks = await listWithDetails<WireWebhook, Snapshot["webhooks"][number]>(
          "/webhooks",
          "Webhooks",
          onProgress,
          async (item) => {
            const { body } = await get<WireWebhook>(path("webhooks", item.id));
            return {
              id: item.id,
              endpoint: body.endpoint ?? item.endpoint,
              events: body.events ?? item.events ?? [],
              status: body.status ?? item.status ?? "enabled",
              signingSecret: body.signing_secret ?? null,
            };
          },
        );
      }
      if (include.has("suppressions")) {
        const list = await listAll<WireSuppression>(
          "/suppressions",
          {},
          "Suppressions",
          onProgress,
        );
        snapshot.suppressions = list.map((row) => ({
          email: row.email,
          origin: row.origin ?? "manual",
          createdAt: row.created_at ?? "",
        }));
      }
      if (include.has("api-keys")) {
        const list = await listAll<WireApiKey>("/api-keys", {}, "API keys", onProgress);
        snapshot.apiKeys = list.map((key) => ({ name: key.name, createdAt: key.created_at }));
      }
      return snapshot;
    },

    async enrichContacts(snapshot, { alreadyDone, onProgress, onContact }) {
      const wantProperties = snapshot.properties.length > 0;
      const wantTopics = snapshot.topics.length > 0;
      const total = snapshot.contacts.length;
      if (wantProperties || wantTopics) {
        for (const [index, contact] of snapshot.contacts.entries()) {
          if (alreadyDone?.has(contact.id) !== true) {
            const enriched: SourceContact = { ...contact };
            if (wantProperties) {
              const { body } = await get<WireContact>(path("contacts", contact.id));
              enriched.properties = toProperties(body.properties);
            }
            if (wantTopics) {
              const topics = await listAll<WireContactTopic>(
                path("contacts", contact.id, "topics"),
              );
              enriched.topics = topics.map((topic) => ({
                id: topic.id,
                subscription: topic.subscription ?? "opt_in",
              }));
            }
            snapshot.contacts[index] = enriched;
            await onContact(enriched);
          }
          onProgress?.({ label: "Enrichment", n: index + 1, total, done: false });
        }
      }
      onProgress?.({ label: "Enrichment", n: total, total, done: true });
      snapshot.enriched = true;
      return snapshot;
    },

    async readMetrics() {
      const end = new Date();
      const start = new Date(end.getTime() - METRICS_WINDOW_DAYS * 86_400_000);
      try {
        const { body } = await get<{ totals?: Record<string, unknown> }>("/emails/metrics", {
          query: {
            start_date: start.toISOString(),
            end_date: end.toISOString(),
            metrics: "sent",
          },
        });
        const sent = body.totals?.sent;
        return { emailsLast30Days: typeof sent === "number" ? sent : null };
      } catch (error) {
        log.debug(`metrics unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return { emailsLast30Days: null };
      }
    },
  };
}

const pagesOf = (count: number): number => Math.max(1, Math.ceil(count / PAGE));

/**
 * Requests the shallow read cost (reconstructed from the snapshot) and the
 * enrichment pass still costs: one GET per contact per enrichable facet.
 */
export function estimateSourceRequests(snapshot: Snapshot): {
  spent: number;
  enrichment: number;
} {
  const s = snapshot;
  const spent =
    pagesOf(s.domains.length) +
    s.domains.length +
    pagesOf(s.properties.length) +
    pagesOf(s.topics.length) +
    pagesOf(s.segments.length) +
    s.segments.reduce((sum, segment) => sum + 1 + pagesOf(segment.memberEmails.length), 0) +
    pagesOf(s.contacts.length) +
    pagesOf(s.broadcasts.length) +
    s.broadcasts.filter((b) => b.status !== "sent" || b.html !== null || b.text !== null).length +
    pagesOf(s.templates.length) +
    s.templates.length +
    pagesOf(s.webhooks.length) +
    s.webhooks.length +
    pagesOf(s.suppressions.length) +
    pagesOf(s.apiKeys.length);
  const facets = (s.properties.length > 0 ? 1 : 0) + (s.topics.length > 0 ? 1 : 0);
  return { spent, enrichment: s.contacts.length * facets };
}
