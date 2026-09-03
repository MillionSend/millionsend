import type { Logger } from "./log.js";
import {
  BATCH_MAX,
  type ContactBatchItem,
  type MillionSendTarget,
  type WriteResult,
} from "./millionsend.js";
import type {
  DnsRecord,
  MigrateState,
  Plan,
  PlanItem,
  Resource,
  Snapshot,
  SourceContact,
} from "./model.js";
import type {
  BroadcastPayload,
  DomainPayload,
  PropertyPayload,
  SegmentPayload,
  TemplatePayload,
  TopicPayload,
  WebhookPayload,
} from "./plan.js";
import type { Progress, StepHandle } from "./progress.js";
import type { Source } from "./providers/index.js";
import { chunk, formatNumber, pluralize } from "./utils.js";

export interface ResourceCounts {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  manual: number;
  failed: number;
}
export type Counts = Partial<Record<Resource, ResourceCounts>>;

export interface ApplyOutcome {
  state: MigrateState;
  counts: Counts;
  /** Minted this run; printed once, never written to a file. */
  freshSecrets: { endpoint: string; secret: string }[];
  /** DNS records of the domains created this run, as the target reports them. */
  domainRecords: Record<string, DnsRecord[]>;
  /** Source id → target id for the resources code refers to by id. */
  ids: IdMapping[];
}

export interface IdMapping {
  resource: "topics" | "segments";
  name: string;
  sourceId: string;
  targetId: string;
}

export interface ApplyInput {
  plan: Plan;
  snapshot: Snapshot;
  source: Source;
  target: MillionSendTarget;
  state: MigrateState;
  onConflict: "upsert" | "skip" | "error";
  progress: Progress;
  log: Logger;
  /** Called after every write so an interrupt leaves the file consistent. */
  save: (state: MigrateState) => void;
}

/** Reverse dependency order: nothing is deleted before what refers to it. */
export const ROLLBACK_ORDER: Resource[] = [
  "broadcasts",
  "templates",
  "webhooks",
  "contacts",
  "segments",
  "topics",
  "properties",
  "suppressions",
  "domains",
];

export const RESOURCE_LABEL: Record<Resource, string> = {
  properties: "Contact properties",
  topics: "Topics",
  segments: "Segments",
  domains: "Domains",
  webhooks: "Webhooks",
  templates: "Templates",
  contacts: "Contacts",
  enrichment: "Enrichment",
  broadcasts: "Broadcasts",
  suppressions: "Suppressions",
  "api-keys": "API keys",
};

const emptyCounts = (): ResourceCounts => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  manual: 0,
  failed: 0,
});

const finish = (step: StepHandle, failed: number, total: number): void => {
  if (failed > 0) step.fail(`${formatNumber(failed)} of ${formatNumber(total)} failed`);
  else step.done();
};

/**
 * The enrichment upsert for one contact. `created` is a contact's first
 * enrichment and carries the full topic list; `updated` is a later sync and
 * only carries opt-outs, so an opt-out made on the target after the first pass
 * is never flipped back to opt_in.
 */
export function enrichmentItem(
  c: SourceContact,
  pass1Status: "created" | "updated",
  maps: { propertyKeys: ReadonlySet<string>; topicBySource: ReadonlyMap<string, string> },
): ContactBatchItem {
  const properties = Object.fromEntries(
    Object.entries(c.properties ?? {}).filter(([key]) => maps.propertyKeys.has(key)),
  );
  const topics = (c.topics ?? []).flatMap((t) => {
    const id = maps.topicBySource.get(t.id);
    if (id === undefined || (pass1Status === "updated" && t.subscription !== "opt_out")) return [];
    return [{ id, subscription: t.subscription }];
  });
  return {
    email: c.email,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(topics.length > 0 ? { topics } : {}),
  };
}

/** Writes the plan to the target in dependency order; one failed item never stops the run. */
export async function applyPlan(input: ApplyInput): Promise<ApplyOutcome> {
  const { plan, snapshot, source, target, state, progress, log } = input;
  const counts: Counts = {};
  const tally = (resource: Resource): ResourceCounts => {
    counts[resource] ??= emptyCounts();
    return counts[resource];
  };
  const created = (resource: Resource, id: string): void => {
    state.created[resource] ??= [];
    state.created[resource].push(id);
    tally(resource).created += 1;
  };
  const failed = (resource: Resource, key: string, message: string): void => {
    state.failures.push({ resource, key, message });
    tally(resource).failed += 1;
    log.warn(`${resource}/${key}: ${message}`);
  };
  const save = (): void => {
    state.updatedAt = new Date().toISOString();
    input.save(state);
  };
  const outcome: ApplyOutcome = { state, counts, freshSecrets: [], domainRecords: {}, ids: [] };

  // Target ids by name (broadcast references) and by source id (contact associations).
  const topicByName = new Map<string, string>();
  const topicBySource = new Map<string, string>();
  const segmentByName = new Map<string, string>();
  const segmentBySource = new Map<string, string>();
  const propertyKeys = new Set<string>();
  const registerTopic = (name: string, id: string): void => {
    topicByName.set(name, id);
    const sourceTopic = snapshot.topics.find((t) => t.name === name);
    if (sourceTopic) topicBySource.set(sourceTopic.id, id);
  };
  const registerSegment = (name: string, id: string): void => {
    segmentByName.set(name, id);
    const sourceSegment = snapshot.segments.find((s) => s.name === name);
    if (sourceSegment) segmentBySource.set(sourceSegment.id, id);
  };
  for (const item of plan.items) {
    if (item.action === "unchanged") tally(item.resource).unchanged += 1;
    else if (item.action === "manual") tally(item.resource).manual += 1;
    else if (item.action === "skip") tally(item.resource).skipped += 1;
    if (item.targetId === undefined) continue;
    if (item.resource === "topics") registerTopic(item.key, item.targetId);
    else if (item.resource === "segments") registerSegment(item.key, item.targetId);
    else if (item.resource === "properties") propertyKeys.add(item.key);
  }

  async function runRows(
    resource: Resource,
    run: (item: PlanItem) => Promise<WriteResult<{ id: string }>>,
  ): Promise<void> {
    const items = plan.items.filter(
      (i) => i.resource === resource && (i.action === "create" || i.action === "update"),
    );
    if (items.length === 0) return;
    const step = progress.step(RESOURCE_LABEL[resource]);
    let n = 0;
    let failures = 0;
    for (const item of items) {
      const result = await run(item);
      if (result.ok) {
        if (item.action === "create") created(resource, result.id);
        else tally(resource).updated += 1;
      } else {
        failed(resource, item.key, result.message);
        failures += 1;
      }
      step.update(++n, items.length);
      save();
    }
    finish(step, failures, items.length);
  }

  await runRows("properties", async (item) => {
    const p = item.payload as PropertyPayload;
    const result = await target.createProperty({
      key: p.key,
      type: p.type,
      fallbackValue: p.fallback_value,
    });
    if (result.ok) propertyKeys.add(p.key);
    return result;
  });

  await runRows("topics", async (item) => {
    if (item.action === "update") {
      return target.updateTopic(item.targetId ?? "", item.payload as { description: string });
    }
    const p = item.payload as TopicPayload;
    const result = await target.createTopic({
      name: p.name,
      description: p.description,
      defaultSubscription: p.default_subscription,
      visibility: p.visibility,
    });
    if (result.ok) registerTopic(p.name, result.id);
    return result;
  });

  await runRows("segments", async (item) => {
    if (item.action === "update") {
      return target.updateSegment(item.targetId ?? "", item.payload as { filter: unknown });
    }
    const p = item.payload as SegmentPayload;
    const result = await target.createSegment({ name: p.name, filter: p.filter });
    if (result.ok) registerSegment(p.name, result.id);
    return result;
  });

  await runRows("domains", async (item) => {
    const { create, tracking } = item.payload as DomainPayload;
    const result = await target.createDomain({
      name: create.name,
      customReturnPath: create.custom_return_path,
    });
    if (!result.ok) return result;
    outcome.domainRecords[create.name] = result.records;
    const patched = await target.updateDomainTracking(result.id, {
      openTracking: tracking.open_tracking,
      clickTracking: tracking.click_tracking,
      trackingSubdomain: tracking.tracking_subdomain,
    });
    if (patched.ok) outcome.domainRecords[create.name] = patched.records;
    else
      failed("domains", create.name, `created, but tracking settings failed: ${patched.message}`);
    return result;
  });

  await runRows("webhooks", async (item) => {
    if (item.action === "update") {
      return target.updateWebhook(
        item.targetId ?? "",
        item.payload as { events?: string[]; status?: "enabled" | "disabled" },
      );
    }
    const p = item.payload as WebhookPayload;
    const copied =
      p.signingSecret === "copy"
        ? (snapshot.webhooks.find((w) => w.id === p.sourceId)?.signingSecret ?? null)
        : null;
    const result = await target.createWebhook({
      endpoint: p.endpoint,
      events: p.events,
      signingSecret: copied,
    });
    if (result.ok && copied === null) {
      outcome.freshSecrets.push({ endpoint: p.endpoint, secret: result.signingSecret });
    }
    return result;
  });

  await runRows("templates", (item) =>
    item.action === "update"
      ? target.updateTemplate(
          item.targetId ?? "",
          item.payload as { name: string; alias: string | null },
        )
      : target.createTemplate(item.payload as TemplatePayload),
  );

  // Pass 1 result per address; enrichment leaves skipped/failed contacts alone.
  const pass1 = new Map<string, "created" | "updated" | "skipped" | "failed">();
  if (plan.items.some((i) => i.resource === "contacts") && snapshot.contacts.length > 0) {
    const step = progress.step(RESOURCE_LABEL.contacts);
    const membership = new Map<string, { id: string }[]>();
    for (const segment of snapshot.segments) {
      const id = segmentBySource.get(segment.id);
      if (id === undefined) continue;
      for (const email of segment.memberEmails) {
        const key = email.toLowerCase();
        const list = membership.get(key) ?? [];
        list.push({ id });
        membership.set(key, list);
      }
    }
    const total = snapshot.contacts.length;
    const cursor = state.progress.contactsCursor ?? null;
    let done = cursor === null ? 0 : snapshot.contacts.findIndex((c) => c.id === cursor) + 1;
    if (done > 0) step.note(`resuming after ${formatNumber(done)} contacts done in an earlier run`);
    step.update(done, total);
    for (const slice of chunk(snapshot.contacts.slice(done), BATCH_MAX)) {
      const items = slice.map(
        (c): ContactBatchItem => ({
          email: c.email,
          first_name: c.firstName ?? undefined,
          last_name: c.lastName ?? undefined,
          unsubscribed: c.unsubscribed,
          segments: membership.get(c.email.toLowerCase()),
        }),
      );
      const out = await target.batchContacts(items, { onConflict: input.onConflict });
      for (const row of out.data) {
        const contact = slice[row.index];
        if (contact === undefined) continue;
        pass1.set(contact.email.toLowerCase(), row.status);
        if (row.status === "created") created("contacts", row.id);
        else tally("contacts")[row.status] += 1;
      }
      for (const error of out.errors) {
        const contact = slice[error.index];
        pass1.set(contact?.email.toLowerCase() ?? "", "failed");
        failed("contacts", contact?.email ?? `#${error.index}`, error.message);
      }
      done += slice.length;
      state.progress.contactsCursor = slice.at(-1)?.id ?? null;
      step.update(done, total);
      save();
    }
    state.progress.contactsCursor = null;
    save();
    finish(step, tally("contacts").failed, total);
  }

  if (plan.items.some((i) => i.resource === "enrichment")) {
    const step = progress.step(RESOURCE_LABEL.enrichment);
    // A resume cursor, not a ledger: holds the ids upserted so far in an interrupted
    // run and is cleared once the pass completes, so the next sync refreshes everyone.
    const doneIds = new Set(state.progress.enrichmentDone ?? []);
    if (doneIds.size > 0) {
      step.note(
        `resuming: skipping ${pluralize(doneIds.size, "contact")} enriched in an earlier run`,
      );
    }
    // Until one pass has reached the end, no contact has been enriched yet (an
    // interrupted first run resumes with the full topic list); afterwards only
    // contacts created in this run are new.
    const synced = state.progress.enrichmentCompleted === true;
    let buffer: { id: string; item: ContactBatchItem }[] = [];
    const flush = async (): Promise<void> => {
      const sendable = buffer.filter((b) => b.item.properties !== undefined || b.item.topics);
      const failedIds = new Set<string>();
      if (sendable.length > 0) {
        const out = await target.batchContacts(
          sendable.map((b) => b.item),
          { onConflict: "upsert" },
        );
        tally("enrichment").updated += out.data.length;
        for (const error of out.errors) {
          const entry = sendable[error.index];
          if (entry !== undefined) failedIds.add(entry.id);
          failed("enrichment", entry?.item.email ?? `#${error.index}`, error.message);
        }
      }
      for (const b of buffer) if (!failedIds.has(b.id)) doneIds.add(b.id);
      state.progress.enrichmentDone = [...doneIds];
      buffer = [];
      save();
    };
    await source.enrichContacts(snapshot, {
      alreadyDone: doneIds,
      onProgress: (event) => step.update(event.n, event.total),
      onContact: async (contact) => {
        const status = pass1.get(contact.email.toLowerCase());
        if (status === "failed" || status === "skipped") return;
        const item = enrichmentItem(
          contact,
          status === "created" || !synced ? "created" : "updated",
          {
            propertyKeys,
            topicBySource,
          },
        );
        buffer.push({ id: contact.id, item });
        if (buffer.length >= BATCH_MAX) await flush();
      },
    });
    await flush();
    state.progress.enrichmentCompleted = true;
    if (tally("enrichment").failed === 0) {
      delete state.progress.enrichmentDone;
      state.progress.contactsCursor = null;
    }
    save();
    finish(step, tally("enrichment").failed, snapshot.contacts.length);
  }

  await runRows("broadcasts", (item) => {
    const { input: b, segmentName, topicName } = item.payload as BroadcastPayload;
    return target.createBroadcast({
      name: b.name,
      from: b.from,
      subject: b.subject,
      html: b.html,
      text: b.text,
      replyTo: b.reply_to,
      previewText: b.preview_text,
      segmentId: segmentName === null ? null : segmentByName.get(segmentName),
      topicId: topicName === null ? null : topicByName.get(topicName),
    });
  });

  if (plan.items.some((i) => i.resource === "suppressions") && snapshot.suppressions.length > 0) {
    const step = progress.step(RESOURCE_LABEL.suppressions);
    const existing = new Set(await target.listSuppressionIds());
    const total = snapshot.suppressions.length;
    let done = 0;
    for (const origin of ["bounce", "complaint", "manual"] as const) {
      const rows = snapshot.suppressions.filter((s) => s.origin === origin);
      for (const slice of chunk(rows, BATCH_MAX)) {
        const out = await target.addSuppressions(
          slice.map((s) => s.email),
          origin,
        );
        for (const id of out.ids) {
          if (existing.has(id)) {
            tally("suppressions").unchanged += 1;
          } else {
            existing.add(id);
            created("suppressions", id);
          }
        }
        for (const error of out.errors) {
          failed("suppressions", slice[error.index]?.email ?? `#${error.index}`, error.message);
        }
        done += slice.length;
        step.update(done, total);
        save();
      }
    }
    state.progress.suppressionsDone = true;
    save();
    finish(step, tally("suppressions").failed, total);
  }

  const mapping = (
    resource: IdMapping["resource"],
    rows: { id: string; name: string }[],
    bySource: ReadonlyMap<string, string>,
  ): IdMapping[] =>
    rows.flatMap((row) => {
      const targetId = bySource.get(row.id);
      return targetId === undefined
        ? []
        : [{ resource, name: row.name, sourceId: row.id, targetId }];
    });
  outcome.ids = [
    ...mapping("topics", snapshot.topics, topicBySource),
    ...mapping("segments", snapshot.segments, segmentBySource),
  ];
  return outcome;
}
