export const PROVIDERS = ["resend"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Plan/--only/--skip vocabulary, in apply order. `enrichment` is the per-contact second pass. */
export const RESOURCES = [
  "domains",
  "properties",
  "topics",
  "segments",
  "contacts",
  "enrichment",
  "broadcasts",
  "templates",
  "webhooks",
  "suppressions",
  "api-keys",
] as const;
export type Resource = (typeof RESOURCES)[number];

/** One DNS row as both Resend and MillionSend present it. */
export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string | undefined;
  priority?: number | undefined;
  status?: string | undefined;
}

export interface SourceDomain {
  name: string;
  region: string;
  openTracking: boolean;
  clickTracking: boolean;
  trackingSubdomain: string | null;
  customReturnPath: string | null;
  records: DnsRecord[];
  status: string;
}

export interface SourceApiKey {
  name: string;
  createdAt: string;
}

export interface SourceProperty {
  key: string;
  type: "string" | "number";
  fallbackValue?: string | number | null | undefined;
}

export interface SourceTopic {
  id: string;
  name: string;
  description: string | null;
  defaultSubscription: "opt_in" | "opt_out";
  visibility?: "public" | "private" | undefined;
}

export interface SourceSegment {
  id: string;
  name: string;
  filter: unknown | null;
  memberEmails: string[];
}

export interface SourceContactTopic {
  id: string;
  subscription: "opt_in" | "opt_out";
}

export interface SourceContact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  unsubscribed: boolean;
  createdAt: string;
  /** Present only after the enrichment pass. */
  properties?: Record<string, string | number> | undefined;
  /** Present only after the enrichment pass. */
  topics?: SourceContactTopic[] | undefined;
}

export interface SourceBroadcast {
  id: string;
  name: string;
  from: string;
  subject: string;
  replyTo: string[] | null;
  previewText: string | null;
  html: string | null;
  text: string | null;
  status: string;
  segmentId: string | null;
  topicId: string | null;
  scheduledAt: string | null;
}

export interface SourceTemplateVariable {
  key: string;
  type: string;
  fallbackValue?: string | number | null | undefined;
}

export interface SourceTemplate {
  id: string;
  name: string;
  alias: string | null;
  from: string | null;
  subject: string | null;
  replyTo: string[] | null;
  html: string | null;
  text: string | null;
  variables: SourceTemplateVariable[];
}

export interface SourceWebhook {
  id: string;
  endpoint: string;
  events: string[];
  status: string;
  signingSecret: string | null;
}

export interface SourceSuppression {
  email: string;
  origin: "bounce" | "complaint" | "manual";
  createdAt: string;
}

export interface SourceMetrics {
  emailsLast30Days: number | null;
}

/** Everything read from the source provider, in provider-neutral terms. */
export interface Snapshot {
  provider: ProviderId;
  takenAt: string;
  domains: SourceDomain[];
  apiKeys: SourceApiKey[];
  properties: SourceProperty[];
  topics: SourceTopic[];
  segments: SourceSegment[];
  contacts: SourceContact[];
  broadcasts: SourceBroadcast[];
  templates: SourceTemplate[];
  webhooks: SourceWebhook[];
  suppressions: SourceSuppression[];
  metrics: SourceMetrics;
  /** True once contacts carry properties and topic subscriptions. */
  enriched: boolean;
}

export interface TargetUsage {
  cloud: boolean;
  plan: string | null;
  limits: { emailsPerDay: number | null; domains: number | null };
  today: { emailsSent: number };
  appUrl: string | null;
}

export interface TargetDomain {
  id: string;
  name: string;
  region: string;
  status: string;
  records: DnsRecord[];
}

export interface TargetProperty {
  id: string;
  key: string;
  type: "string" | "number";
}

export interface TargetTopic {
  id: string;
  name: string;
  description: string | null;
  defaultSubscription: "opt_in" | "opt_out";
}

export interface TargetSegment {
  id: string;
  name: string;
  filter: unknown | null;
}

export interface TargetWebhook {
  id: string;
  endpoint: string;
  events: string[];
  status: string;
}

export interface TargetTemplate {
  id: string;
  name: string;
  alias: string | null;
  /** Bodies come from GET /templates/{id}; the plan diffs them against the source. */
  subject?: string | null | undefined;
  html?: string | undefined;
  text?: string | null | undefined;
}

export interface TargetBroadcast {
  id: string;
  name: string;
  status: string;
}

/** What the target already has — the plan diffs the Snapshot against this. */
export interface TargetState {
  /** At least one contact exists on the target; enrichment can run without a contacts pass. */
  hasContacts?: boolean | undefined;
  usage: TargetUsage;
  domains: TargetDomain[];
  properties: TargetProperty[];
  topics: TargetTopic[];
  segments: TargetSegment[];
  webhooks: TargetWebhook[];
  templates: TargetTemplate[];
  broadcasts: TargetBroadcast[];
}

export type PlanAction = "create" | "update" | "unchanged" | "manual" | "skip";

export interface PlanItem {
  resource: Resource;
  action: PlanAction;
  /** The matching key on the target: name, property key, endpoint, alias, email… */
  key: string;
  detail?: string | undefined;
  targetId?: string | undefined;
  payload?: unknown;
  /** For aggregate items (contacts, suppressions): how many rows the item stands for. */
  count?: number | undefined;
}

export interface Plan {
  version: 1;
  createdAt: string;
  source: ProviderId;
  target: { baseUrl: string; cloud: boolean; plan: string | null };
  rps: number;
  items: PlanItem[];
  counts: Record<PlanAction, number>;
  estimate: { requests: number; seconds: number };
  warnings: string[];
  manual: { title: string; detail: string }[];
}

/** .millionsend/migrate-state.json — never holds a key. */
export interface MigrateState {
  version: 1;
  startedAt: string;
  updatedAt: string;
  planHash: string;
  target: { baseUrl: string };
  /** Resource → ids this tool created there; the only ids rollback may delete. */
  created: Record<string, string[]>;
  progress: {
    contactsCursor?: string | null | undefined;
    /** Resume ledgers of the two enrichment passes: contact ids whose properties / topics were written. */
    enrichmentDone?: string[] | undefined;
    topicsDone?: string[] | undefined;
    /** Set once both enrichment passes have reached the end of the source; later runs are syncs. */
    enrichmentCompleted?: boolean | undefined;
    suppressionsDone?: boolean | undefined;
  };
  failures: { resource: Resource; key: string; message: string }[];
}
