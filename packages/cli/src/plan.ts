import { createHash } from "node:crypto";
import type {
  Plan,
  PlanAction,
  PlanItem,
  Resource,
  Snapshot,
  TargetState,
  TargetWebhook,
} from "./model.js";
import { estimateSourceRequests } from "./providers/index.js";
import {
  type BroadcastCreateInput,
  broadcastCreateInput,
  type DomainCreateInput,
  type DomainTrackingInput,
  domainCreateInput,
  type SegmentFilter,
  type TargetWebhookEvent,
  type TemplateCreateInput,
  templateCreateInput,
  translateSegmentFilter,
  translateWebhookEvents,
} from "./translate.js";
import {
  canonicalJson,
  capitalize,
  formatDuration,
  formatNumber,
  pluralize,
  senderDomain,
  stripControl,
} from "./utils.js";

export const PLAN_VERSION = 1;
const BATCH_SIZE = 1000;

/** Item order: each resource only references ones created before it. */
const RESOURCE_ORDER: Resource[] = [
  "properties",
  "topics",
  "segments",
  "domains",
  "webhooks",
  "templates",
  "contacts",
  "enrichment",
  "broadcasts",
  "suppressions",
  "api-keys",
];

export interface PropertyPayload {
  key: string;
  type: "string" | "number";
  fallback_value?: string | number | null;
}
export interface TopicPayload {
  name: string;
  description?: string;
  default_subscription: "opt_in" | "opt_out";
  visibility?: "public" | "private";
}
export interface SegmentPayload {
  name: string;
  filter?: SegmentFilter;
}
export interface DomainPayload {
  create: DomainCreateInput;
  tracking: DomainTrackingInput;
}
/** Secrets never enter the plan: apply reads the source secret by `sourceId`. */
export interface WebhookPayload {
  endpoint: string;
  events: TargetWebhookEvent[];
  sourceId: string;
  signingSecret: "copy" | "fresh";
}
export type TemplatePayload = TemplateCreateInput;
/** segment_id/topic_id are filled at apply time by name, once those rows exist. */
export interface BroadcastPayload {
  input: BroadcastCreateInput;
  segmentName: string | null;
  topicName: string | null;
}

export interface PlanOptions {
  include: Set<Resource>;
  includeSent: boolean;
  freshWebhookSecrets: boolean;
  rps: number;
  /** Requests already spent reading the source; counted into the estimate. */
  sourceRequestsSpent: number;
  baseUrl: string;
  now?: Date | undefined;
}

type ItemInit = Omit<PlanItem, "resource" | "action" | "key">;

/** Field names whose values differ between source and target, for the update detail. */
function changedFields(pairs: [string, unknown, unknown][]): string[] {
  return pairs.filter(([, a, b]) => canonicalJson(a) !== canonicalJson(b)).map(([name]) => name);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

export function buildPlan({
  snapshot,
  target,
  options,
}: {
  snapshot: Snapshot;
  target: TargetState;
  options: PlanOptions;
}): Plan {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const add = (resource: Resource, action: PlanAction, key: string, init: ItemInit = {}): void => {
    items.push({ resource, action, key, ...init });
  };
  const manual = (resource: Resource, key: string, detail: string): void =>
    add(resource, "manual", key, { detail });
  const has = (resource: Resource): boolean => options.include.has(resource);

  if (has("properties")) {
    for (const p of snapshot.properties) {
      const existing = target.properties.find((t) => t.key === p.key);
      if (!existing) {
        const payload: PropertyPayload = {
          key: p.key,
          type: p.type,
          ...(p.fallbackValue !== undefined ? { fallback_value: p.fallbackValue } : {}),
        };
        add("properties", "create", p.key, { payload, detail: p.type });
      } else if (existing.type !== p.type) {
        manual(
          "properties",
          p.key,
          `type differs: ${p.type} on Resend, ${existing.type} here — a property's type cannot change`,
        );
      } else {
        add("properties", "unchanged", p.key, { targetId: existing.id });
      }
    }
  }

  if (has("topics")) {
    for (const t of snapshot.topics) {
      const existing = target.topics.find((x) => x.name === t.name);
      if (!existing) {
        const payload: TopicPayload = {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          default_subscription: t.defaultSubscription,
          ...(t.visibility ? { visibility: t.visibility } : {}),
        };
        add("topics", "create", t.name, { payload, detail: t.defaultSubscription });
        continue;
      }
      if (existing.defaultSubscription !== t.defaultSubscription) {
        manual(
          "topics",
          t.name,
          `default_subscription differs: ${t.defaultSubscription} on Resend, ${existing.defaultSubscription} here — it is fixed at creation`,
        );
      }
      const changed = changedFields([
        ["description", t.description ?? "", existing.description ?? ""],
      ]);
      if (changed.length > 0) {
        add("topics", "update", t.name, {
          targetId: existing.id,
          detail: changed.join(", "),
          payload: { description: t.description ?? "" },
        });
      } else {
        add("topics", "unchanged", t.name, { targetId: existing.id });
      }
    }
  }

  if (has("segments")) {
    for (const s of snapshot.segments) {
      const translated = s.filter === null ? null : translateSegmentFilter(s.filter);
      const existing = target.segments.find((x) => x.name === s.name);
      const filter = translated?.filter ?? null;
      if (!existing) {
        const payload: SegmentPayload = { name: s.name, ...(filter ? { filter } : {}) };
        add("segments", "create", s.name, {
          payload,
          detail: `${filter ? "filter, " : ""}${pluralize(s.memberEmails.length, "member")}`,
        });
      } else if (filter && canonicalJson(filter) !== canonicalJson(existing.filter)) {
        add("segments", "update", s.name, {
          targetId: existing.id,
          detail: "filter",
          payload: { filter },
        });
      } else {
        add("segments", "unchanged", s.name, { targetId: existing.id });
      }
      if (translated?.reason) {
        manual(
          "segments",
          s.name,
          `filter not translated (${translated.reason}); ${pluralize(s.memberEmails.length, "member")} still imported`,
        );
      }
    }
  }

  if (has("domains")) {
    let creates = 0;
    for (const d of snapshot.domains) {
      const existing = target.domains.find((x) => x.name === d.name);
      if (existing) {
        add("domains", "unchanged", d.name, { targetId: existing.id });
        if (existing.status !== "verified") {
          manual("domains", d.name, `add ${pluralize(existing.records.length, "DNS record")}`);
        }
        continue;
      }
      const { input, tracking, reason } = domainCreateInput(d);
      if (!input) {
        manual("domains", d.name, reason ?? "cannot be created");
        continue;
      }
      creates += 1;
      const payload: DomainPayload = { create: input, tracking };
      add("domains", "create", d.name, { payload, detail: input.region });
      manual("domains", d.name, DNS_AFTER_APPLY);
    }
    const limit = target.usage.limits.domains;
    if (limit !== null && creates > 0 && target.domains.length + creates > limit) {
      warnings.push(
        `${pluralize(creates, "domain")} to create; the ${capitalize(target.usage.plan ?? "current")} plan allows ${limit} (${target.domains.length} already there)`,
      );
    }
  }

  if (has("webhooks")) {
    for (const w of snapshot.webhooks) {
      const { events, dropped } = translateWebhookEvents(w.events);
      const droppedNote = (): void => {
        if (dropped.length > 0)
          manual("webhooks", w.endpoint, `events not delivered here: ${dropped.join(", ")}`);
      };
      if (events.length === 0) {
        manual("webhooks", w.endpoint, "none of its events exist here; not created");
        droppedNote();
        continue;
      }
      const existing = target.webhooks.find((x) => x.endpoint === w.endpoint);
      if (!existing) {
        const payload: WebhookPayload = {
          endpoint: w.endpoint,
          events,
          sourceId: w.id,
          signingSecret: options.freshWebhookSecrets || !w.signingSecret ? "fresh" : "copy",
        };
        add("webhooks", "create", w.endpoint, {
          payload,
          detail: `${pluralize(events.length, "event")}, ${payload.signingSecret === "copy" ? "secret copied" : "fresh secret"}`,
        });
        droppedNote();
        continue;
      }
      const update = webhookUpdate(existing, events, w.status);
      if (update) {
        add("webhooks", "update", w.endpoint, {
          targetId: existing.id,
          detail: Object.keys(update).join(", "),
          payload: update,
        });
      } else {
        add("webhooks", "unchanged", w.endpoint, { targetId: existing.id });
      }
      droppedNote();
    }
  }

  if (has("templates")) {
    for (const t of snapshot.templates) {
      const { input, notes, reason } = templateCreateInput(t);
      const label = t.alias ?? t.name;
      const existing =
        (t.alias ? target.templates.find((x) => x.alias === t.alias) : undefined) ??
        target.templates.find((x) => x.name === t.name);
      if (!input) {
        manual("templates", label, reason ?? "cannot be created");
      } else if (!existing) {
        add("templates", "create", label, {
          payload: input,
          ...(t.alias ? { detail: t.name } : {}),
        });
      } else {
        // Only the fields that differ go in the PATCH: a body write also resets the target's visual-editor document.
        const desired: Record<string, unknown> = {
          name: input.name,
          alias: t.alias,
          subject: input.subject ?? null,
          html: input.html,
          text: input.text ?? null,
        };
        const current: Record<string, unknown> = {
          name: existing.name,
          alias: existing.alias,
          subject: existing.subject ?? null,
          html: existing.html ?? null,
          text: existing.text ?? null,
        };
        const changed = changedFields(
          Object.keys(desired).map((field) => [field, desired[field], current[field]]),
        );
        if (changed.length > 0) {
          add("templates", "update", label, {
            targetId: existing.id,
            detail: changed.join(", "),
            payload: Object.fromEntries(changed.map((field) => [field, desired[field]])),
          });
        } else {
          add("templates", "unchanged", label, { targetId: existing.id });
        }
      }
      for (const note of notes) manual("templates", label, note);
    }
  }

  const contactCount = has("contacts") ? snapshot.contacts.length : 0;
  if (contactCount > 0) {
    const memberships = has("segments")
      ? snapshot.segments.reduce((n, s) => n + s.memberEmails.length, 0)
      : 0;
    add("contacts", "create", "contacts", {
      count: contactCount,
      detail: `batch upsert, ${pluralize(memberships, "segment membership")}`,
    });
  }

  const enrichment =
    has("enrichment") &&
    contactCount > 0 &&
    !snapshot.enriched &&
    (snapshot.properties.length > 0 || snapshot.topics.length > 0);
  if (enrichment) {
    add("enrichment", "update", "contacts", {
      count: contactCount,
      detail: "properties and topic subscriptions, read per contact",
    });
  }

  if (has("broadcasts")) {
    for (const b of snapshot.broadcasts) {
      if (b.status === "sent" && !options.includeSent) {
        add("broadcasts", "skip", b.name, {
          detail: "already sent; --include-sent imports it as a draft",
        });
        continue;
      }
      const existing = target.broadcasts.find((x) => x.name === b.name && x.status === "draft");
      if (existing) {
        add("broadcasts", "unchanged", b.name, {
          targetId: existing.id,
          detail: "matched by name; the draft's body is not compared",
        });
        continue;
      }
      const domain = senderDomain(b.from);
      const verified = target.domains.some((d) => d.name === domain && d.status === "verified");
      const { input, notes, reason } = broadcastCreateInput(b, { segmentId: null, topicId: null });
      if (!input) {
        manual("broadcasts", b.name, reason ?? "cannot be created");
        continue;
      }
      if (!verified) {
        manual(
          "broadcasts",
          b.name,
          `from domain ${domain ?? b.from} is not verified here — re-run apply after DNS verification`,
        );
        continue;
      }
      const payload: BroadcastPayload = {
        input,
        segmentName: snapshot.segments.find((s) => s.id === b.segmentId)?.name ?? null,
        topicName: snapshot.topics.find((t) => t.id === b.topicId)?.name ?? null,
      };
      add("broadcasts", "create", b.name, { payload, detail: "draft" });
      for (const note of notes) manual("broadcasts", b.name, note);
    }
  }

  const suppressionCount = has("suppressions") ? snapshot.suppressions.length : 0;
  if (suppressionCount > 0) {
    add("suppressions", "create", "suppressions", {
      count: suppressionCount,
      detail: "batch add with origin",
    });
  }

  if (has("api-keys")) {
    for (const k of snapshot.apiKeys) {
      manual("api-keys", k.name, "create it by hand; Resend exposes only the name");
    }
  }

  items.sort((a, b) => RESOURCE_ORDER.indexOf(a.resource) - RESOURCE_ORDER.indexOf(b.resource));

  const batches = (n: number): number => Math.ceil(n / BATCH_SIZE);
  const rowWrites = items.filter(
    (i) => (i.action === "create" || i.action === "update") && i.count === undefined,
  ).length;
  const writes =
    rowWrites +
    batches(contactCount) +
    batches(suppressionCount) +
    (enrichment ? batches(contactCount) : 0);
  // Source reads still ahead run at `rps`; target writes at its own 10/s. Spent reads are behind us.
  const reads = enrichment ? estimateSourceRequests(snapshot).enrichment : 0;
  const requests = options.sourceRequestsSpent + reads + writes;
  const seconds = Math.ceil(reads / options.rps + writes / 10);

  return {
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    source: snapshot.provider,
    target: {
      baseUrl: options.baseUrl,
      cloud: target.usage.cloud,
      plan: target.usage.plan,
    },
    rps: options.rps,
    items,
    estimate: { requests, seconds },
    warnings,
    ...summarize(items),
  };
}

function summarize(items: PlanItem[]): Pick<Plan, "counts" | "manual"> {
  const counts: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    manual: 0,
    skip: 0,
  };
  for (const item of items) counts[item.action] += 1;
  return {
    counts,
    manual: items
      .filter((i) => i.action === "manual")
      .map((i) => ({ title: `${i.resource}/${i.key}`, detail: i.detail ?? "" })),
  };
}

const DNS_AFTER_APPLY = "add DNS records (shown after apply)";

/**
 * Keeps the first `allowed` domain creates and turns the rest into manual
 * items (the plan's domain cap); their DNS reminder goes with them.
 */
export function capDomainCreates(plan: Plan, allowed: number): Plan {
  let kept = 0;
  const capped = new Set<string>();
  const items = plan.items.flatMap((item): PlanItem[] => {
    if (item.resource !== "domains") return [item];
    if (item.action === "create") {
      if (kept < allowed) {
        kept += 1;
        return [item];
      }
      capped.add(item.key);
      return [
        {
          resource: "domains",
          action: "manual",
          key: item.key,
          detail: `over the plan's domain limit; add it by hand after upgrading`,
        },
      ];
    }
    if (item.action === "manual" && item.detail === DNS_AFTER_APPLY && capped.has(item.key)) {
      return [];
    }
    return [item];
  });
  return { ...plan, items, ...summarize(items) };
}

function webhookUpdate(
  existing: TargetWebhook,
  events: TargetWebhookEvent[],
  status: string,
): { events?: TargetWebhookEvent[]; status?: string } | null {
  const update: { events?: TargetWebhookEvent[]; status?: string } = {};
  if (!sameSet(existing.events, events)) update.events = events;
  if ((status === "enabled" || status === "disabled") && status !== existing.status)
    update.status = status;
  return Object.keys(update).length > 0 ? update : null;
}

const SYMBOL: Record<PlanAction, string> = {
  create: "+",
  update: "~",
  unchanged: "=",
  manual: "!",
  skip: "-",
};
const COLOR: Record<PlanAction, string> = {
  create: "\x1b[32m",
  update: "\x1b[33m",
  unchanged: "\x1b[90m",
  manual: "\x1b[35m",
  skip: "\x1b[90m",
};

function renderItem(item: PlanItem, color: boolean): string {
  const name =
    item.count === undefined
      ? `${item.resource}/${item.key}`
      : `${item.resource} (${formatNumber(item.count)})`;
  const detail =
    item.detail === undefined
      ? ""
      : item.action === "update" && item.count === undefined
        ? ` (${item.detail})`
        : ` — ${item.detail}`;
  const head = `${SYMBOL[item.action]} ${item.action.padEnd(9)}`;
  return `  ${color ? `${COLOR[item.action]}${head}\x1b[39m` : head}  ${stripControl(`${name}${detail}`)}`;
}

/** Terraform-style listing: legend, one line per item, totals, warnings, estimate. */
export function renderPlan(plan: Plan, { color = false }: { color?: boolean } = {}): string {
  const lines = [
    "Resource actions are indicated with the following symbols:",
    ...(["create", "update", "unchanged", "manual", "skip"] as const).map(
      (a) => `  ${SYMBOL[a]} ${a}`,
    ),
    "",
    ...plan.items.map((item) => renderItem(item, color)),
    "",
    `Plan: ${plan.counts.create} to create, ${plan.counts.update} to update, ${plan.counts.unchanged} unchanged, ${plan.counts.manual} manual${plan.counts.skip > 0 ? `, ${plan.counts.skip} skipped` : ""}.`,
    ...plan.warnings.map((w) => `warning: ${w}`),
    `Estimate: ~${formatNumber(plan.estimate.requests)} requests · ${formatDuration(plan.estimate.seconds)} at ${plan.rps} req/s`,
  ];
  return `${lines.join("\n")}\n`;
}

/** sha256 of the canonical items JSON — the state file binds itself to this. */
export function planHash(plan: Plan): string {
  return createHash("sha256").update(canonicalJson(plan.items)).digest("hex");
}

export const serializePlan = (plan: Plan): string => `${JSON.stringify(plan, null, 2)}\n`;

export function parsePlan(text: string): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("plan file is not valid JSON");
  }
  const plan = parsed as Partial<Plan> | null;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.items)) {
    throw new Error("plan file is not a migration plan");
  }
  if (plan.version !== PLAN_VERSION) {
    throw new Error(
      `plan file version ${String(plan.version)} is not supported (expected ${PLAN_VERSION})`,
    );
  }
  return plan as Plan;
}
