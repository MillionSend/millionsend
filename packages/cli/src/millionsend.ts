import { TARGET_KEY_ENV, TARGET_URL_ENV } from "./config.js";
import { ApiError, AuthError, type Http, type RequestOptions } from "./http.js";
import type { Logger } from "./log.js";
import { VERSION } from "./meta.js";
import type {
  DnsRecord,
  TargetBroadcast,
  TargetDomain,
  TargetProperty,
  TargetSegment,
  TargetState,
  TargetTemplate,
  TargetTopic,
  TargetUsage,
  TargetWebhook,
} from "./model.js";
import { TARGET_WEBHOOK_EVENTS } from "./translate.js";
import { chunk } from "./utils.js";

/** POST /contacts/batch and /suppressions/batch/* accept at most this many items. */
export const BATCH_MAX = 1000;

export interface WriteError {
  ok: false;
  status: number;
  name: string;
  message: string;
}

export type WriteResult<T = { id: string }> = ({ ok: true } & T) | WriteError;

/** One CreateContactRequest as the API takes it (wire names, so the payload is stored verbatim in the plan). */
export interface ContactBatchItem {
  email: string;
  first_name?: string | undefined;
  last_name?: string | undefined;
  unsubscribed?: boolean | undefined;
  properties?: Record<string, string | number> | undefined;
  segments?: { id: string }[] | undefined;
  topics?: { id: string; subscription: "opt_in" | "opt_out" }[] | undefined;
}

export interface BatchOutcome {
  /** Indices refer to the full input array, not the chunk. */
  data: { index: number; id: string; status: "created" | "updated" | "skipped" }[];
  counts: { created: number; updated: number; skipped: number; failed: number };
  errors: { index: number; message: string }[];
}

export interface SuppressionsOutcome {
  /** One id per distinct address the API accepted, existing rows included. */
  ids: string[];
  errors: { index: number; message: string }[];
}

interface ListPage<T> {
  data: T[];
  has_more: boolean;
}

interface UsageWire {
  cloud: boolean;
  plan: string | null;
  limits: { emails_per_day: number | null; domains: number | null };
  today: { emails_sent: number };
  app_url: string | null;
}

interface DomainWire {
  id: string;
  name: string;
  region: string;
  status: string;
  records: DnsRecord[];
}

interface TopicWire {
  id: string;
  name: string;
  description?: string | undefined;
  default_subscription: "opt_in" | "opt_out";
}

interface WebhookWire {
  id: string;
  endpoint: string;
  events: string[] | null;
  status: string;
}

interface TemplateWire {
  id: string;
  name: string;
  alias: string | null;
  subject: string | null;
  html: string;
  text: string | null;
}

type BatchWire = Omit<BatchOutcome, "errors"> & { errors?: BatchOutcome["errors"] | undefined };

const PERMISSIVE = { headers: { "x-batch-validation": "permissive" } };

/** A 4xx the API answered for this one write; anything else (auth, network, 5xx) keeps propagating. */
function writeError(error: unknown): WriteError | null {
  if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) return null;
  const body = error.body as { message?: unknown } | null;
  return {
    ok: false,
    status: error.status,
    name: error.name,
    message: typeof body?.message === "string" ? body.message : error.message,
  };
}

/** `baseUrl` only names the instance in messages; `http` already points at it. */
export function createMillionSendTarget(http: Http, log: Logger, baseUrl = "the MillionSend URL") {
  let requests = 0;
  const api: Http = {
    get: <T>(path: string, options?: RequestOptions) => {
      requests += 1;
      return http.get<T>(path, options);
    },
    post: <T>(path: string, body?: unknown, options?: RequestOptions) => {
      requests += 1;
      return http.post<T>(path, body, options);
    },
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) => {
      requests += 1;
      return http.patch<T>(path, body, options);
    },
    delete: <T>(path: string, options?: RequestOptions) => {
      requests += 1;
      return http.delete<T>(path, options);
    },
  };

  async function write<T>(run: () => Promise<T>): Promise<WriteResult<T>> {
    try {
      return { ok: true, ...(await run()) };
    } catch (error) {
      const failed = writeError(error);
      if (failed) return failed;
      throw error;
    }
  }

  const id = async (response: Promise<{ body: { id: string } }>) => ({
    id: (await response).body.id,
  });

  const withRecords = async (response: Promise<{ body: DomainWire }>) => {
    const { body } = await response;
    return { id: body.id, records: body.records };
  };

  async function listAll<T extends { id: string }>(path: string): Promise<T[]> {
    const rows: T[] = [];
    let after: string | undefined;
    for (;;) {
      const { body } = await api.get<ListPage<T>>(path, { query: { limit: 100, after } });
      rows.push(...body.data);
      const last = body.data.at(-1);
      if (!body.has_more || !last) return rows;
      after = last.id;
    }
  }

  async function probe(): Promise<TargetUsage> {
    let body: UsageWire;
    try {
      ({ body } = await api.get<UsageWire>("/usage"));
    } catch (error) {
      if (error instanceof AuthError) {
        error.message =
          error.status === 403
            ? `MillionSend rejected the API key (403): it is a sending-only key. Migration needs a full-access key (ms_…) for your MillionSend instance in ${TARGET_KEY_ENV}.`
            : `MillionSend rejected the API key (401). Check ${TARGET_KEY_ENV}: it must be a full-access key (ms_…) of your MillionSend instance.`;
      }
      if (error instanceof ApiError && error.status === 404) {
        throw new Error(
          `MillionSend at ${baseUrl} has no GET /usage: either ${baseUrl} is not the API URL of your instance (check --to-url / ${TARGET_URL_ENV}) or the instance predates CLI ${VERSION}; upgrade it.`,
        );
      }
      throw error;
    }
    return {
      cloud: body.cloud,
      plan: body.plan,
      limits: { emailsPerDay: body.limits.emails_per_day, domains: body.limits.domains },
      today: { emailsSent: body.today.emails_sent },
      appUrl: body.app_url,
    };
  }

  async function readState(): Promise<TargetState> {
    const usage = await probe();
    const [domainRows, properties, topics, segments, webhooks, templateRows, broadcasts] =
      await Promise.all([
        listAll<{ id: string }>("/domains"),
        listAll<TargetProperty>("/contact-properties"),
        listAll<TopicWire>("/topics"),
        listAll<TargetSegment>("/segments"),
        listAll<WebhookWire>("/webhooks"),
        listAll<{ id: string }>("/templates"),
        listAll<{ id: string; name: string | null; status: string }>("/broadcasts"),
      ]);
    const domains: TargetDomain[] = [];
    for (const { id } of domainRows) {
      const { body } = await api.get<DomainWire>(`/domains/${id}`);
      domains.push({
        id: body.id,
        name: body.name,
        region: body.region,
        status: body.status,
        records: body.records,
      });
    }
    // The list carries no bodies; the plan diffs subject/html/text against them.
    const templates: TargetTemplate[] = [];
    for (const { id } of templateRows) {
      const { body } = await api.get<TemplateWire>(`/templates/${id}`);
      templates.push({
        id: body.id,
        name: body.name,
        alias: body.alias,
        subject: body.subject,
        html: body.html,
        text: body.text,
      });
    }
    return {
      usage,
      domains,
      properties: properties.map(({ id, key, type }) => ({ id, key, type })),
      topics: topics.map(
        (t): TargetTopic => ({
          id: t.id,
          name: t.name,
          description: t.description ?? null,
          defaultSubscription: t.default_subscription,
        }),
      ),
      segments: segments.map(({ id, name, filter }) => ({ id, name, filter })),
      // null on the wire means every event (dashboard-created endpoints); the plan diffs real sets.
      webhooks: webhooks.map(
        (w): TargetWebhook => ({
          id: w.id,
          endpoint: w.endpoint,
          events: w.events ?? [...TARGET_WEBHOOK_EVENTS],
          status: w.status,
        }),
      ),
      templates,
      broadcasts: broadcasts.map(
        (b): TargetBroadcast => ({ id: b.id, name: b.name ?? "", status: b.status }),
      ),
    };
  }

  async function batchContacts(
    items: ContactBatchItem[],
    {
      onConflict,
      permissive = true,
    }: { onConflict: "upsert" | "skip" | "error"; permissive?: boolean },
  ): Promise<BatchOutcome> {
    const out: BatchOutcome = {
      data: [],
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      errors: [],
    };
    const chunks = chunk(items, BATCH_MAX);
    for (const [n, slice] of chunks.entries()) {
      const base = n * BATCH_MAX;
      if (chunks.length > 1)
        log.debug(`contacts batch ${n + 1}/${chunks.length} (${slice.length})`);
      const result = await write(async () => ({
        body: (
          await api.post<BatchWire>(`/contacts/batch?on_conflict=${onConflict}`, slice, {
            ...(permissive ? PERMISSIVE : {}),
          })
        ).body,
      }));
      if (!result.ok) {
        log.warn(`contacts batch ${n + 1}/${chunks.length} failed: ${result.message}`);
        for (const i of slice.keys()) out.errors.push({ index: base + i, message: result.message });
        out.counts.failed += slice.length;
        continue;
      }
      const { body } = result;
      for (const row of body.data) out.data.push({ ...row, index: base + row.index });
      for (const row of body.errors ?? []) out.errors.push({ ...row, index: base + row.index });
      for (const key of Object.keys(out.counts) as (keyof BatchOutcome["counts"])[]) {
        out.counts[key] += body.counts[key];
      }
    }
    return out;
  }

  async function suppressionsBatch(
    path: string,
    key: "emails" | "ids",
    values: string[],
    extra: Record<string, unknown> = {},
  ): Promise<SuppressionsOutcome> {
    const out: SuppressionsOutcome = { ids: [], errors: [] };
    const chunks = chunk(values, BATCH_MAX);
    for (const [n, slice] of chunks.entries()) {
      const result = await write(async () => ({
        data: (await api.post<{ data: { id: string }[] }>(path, { [key]: slice, ...extra })).body
          .data,
      }));
      if (!result.ok) {
        log.warn(`${path} ${n + 1}/${chunks.length} failed: ${result.message}`);
        for (const i of slice.keys()) {
          out.errors.push({ index: n * BATCH_MAX + i, message: result.message });
        }
        continue;
      }
      out.ids.push(...result.data.map((r) => r.id));
    }
    return out;
  }

  return {
    /** Requests issued so far, for the summary's "~2,140 requests" line. */
    get requests() {
      return requests;
    },
    probe,
    readState,

    createProperty: (input: {
      key: string;
      type: "string" | "number";
      fallbackValue?: string | number | null | undefined;
    }) =>
      write(() =>
        id(
          api.post("/contact-properties", {
            key: input.key,
            type: input.type,
            fallback_value: input.fallbackValue,
          }),
        ),
      ),
    deleteProperty: (propertyId: string) =>
      write(() => id(api.delete(`/contact-properties/${propertyId}`))),

    createTopic: (input: {
      name: string;
      description?: string | null | undefined;
      defaultSubscription: "opt_in" | "opt_out";
      visibility?: "public" | "private" | undefined;
    }) =>
      write(() =>
        id(
          api.post("/topics", {
            name: input.name,
            description: input.description ?? undefined,
            default_subscription: input.defaultSubscription,
            visibility: input.visibility,
          }),
        ),
      ),
    updateTopic: (
      topicId: string,
      input: {
        name?: string | undefined;
        description?: string | null | undefined;
        visibility?: "public" | "private" | undefined;
      },
    ) =>
      write(() =>
        id(
          api.patch(`/topics/${topicId}`, {
            name: input.name,
            description: input.description ?? undefined,
            visibility: input.visibility,
          }),
        ),
      ),
    deleteTopic: (topicId: string) => write(() => id(api.delete(`/topics/${topicId}`))),

    createSegment: (input: { name: string; filter?: unknown }) =>
      write(() =>
        id(
          api.post("/segments", {
            name: input.name,
            ...(input.filter != null ? { filter: input.filter } : {}),
          }),
        ),
      ),
    /** `filter: null` clears the saved filter (manual membership only). */
    updateSegment: (segmentId: string, input: { name?: string | undefined; filter?: unknown }) =>
      write(() =>
        id(
          api.patch(`/segments/${segmentId}`, {
            name: input.name,
            ...(input.filter !== undefined ? { filter: input.filter } : {}),
          }),
        ),
      ),
    deleteSegment: (segmentId: string) => write(() => id(api.delete(`/segments/${segmentId}`))),

    createDomain: (input: { name: string; customReturnPath?: string | null | undefined }) =>
      write(() =>
        withRecords(
          api.post<DomainWire>("/domains", {
            name: input.name,
            custom_return_path: input.customReturnPath ?? undefined,
          }),
        ),
      ),
    updateDomainTracking: (
      domainId: string,
      input: {
        openTracking?: boolean | undefined;
        clickTracking?: boolean | undefined;
        trackingSubdomain?: string | null | undefined;
      },
    ) =>
      write(() =>
        withRecords(
          api.patch<DomainWire>(`/domains/${domainId}`, {
            open_tracking: input.openTracking,
            click_tracking: input.clickTracking,
            tracking_subdomain: input.trackingSubdomain,
          }),
        ),
      ),
    deleteDomain: (domainId: string) => write(() => id(api.delete(`/domains/${domainId}`))),

    createWebhook: (input: {
      endpoint: string;
      events: string[];
      signingSecret?: string | null | undefined;
    }) =>
      write(async () => {
        const { body } = await api.post<{ id: string; signing_secret: string }>("/webhooks", {
          endpoint: input.endpoint,
          events: input.events,
          signing_secret: input.signingSecret ?? undefined,
        });
        return { id: body.id, signingSecret: body.signing_secret };
      }),
    updateWebhook: (
      webhookId: string,
      input: {
        endpoint?: string | undefined;
        events?: string[] | undefined;
        status?: "enabled" | "disabled" | undefined;
      },
    ) => write(() => id(api.patch(`/webhooks/${webhookId}`, input))),
    deleteWebhook: (webhookId: string) => write(() => id(api.delete(`/webhooks/${webhookId}`))),

    createTemplate: (input: {
      name: string;
      alias?: string | null | undefined;
      subject?: string | null | undefined;
      html: string;
      text?: string | null | undefined;
    }) =>
      write(() =>
        id(
          api.post("/templates", {
            name: input.name,
            alias: input.alias ?? undefined,
            subject: input.subject ?? undefined,
            html: input.html,
            text: input.text ?? undefined,
          }),
        ),
      ),
    /** `idOrAlias`: the API resolves either. */
    updateTemplate: (
      idOrAlias: string,
      input: {
        name?: string | undefined;
        alias?: string | null | undefined;
        subject?: string | null | undefined;
        html?: string | undefined;
        text?: string | null | undefined;
      },
    ) => write(() => id(api.patch(`/templates/${idOrAlias}`, input))),
    deleteTemplate: (idOrAlias: string) => write(() => id(api.delete(`/templates/${idOrAlias}`))),

    /** Always a draft; sending stays a deliberate act in the dashboard. */
    createBroadcast: (input: {
      name?: string | null | undefined;
      from: string;
      subject: string;
      html?: string | null | undefined;
      text?: string | null | undefined;
      replyTo?: string[] | null | undefined;
      previewText?: string | null | undefined;
      segmentId?: string | null | undefined;
      topicId?: string | null | undefined;
    }) =>
      write(() =>
        id(
          api.post("/broadcasts", {
            name: input.name ?? undefined,
            from: input.from,
            subject: input.subject,
            html: input.html ?? undefined,
            text: input.text ?? undefined,
            reply_to: input.replyTo ?? undefined,
            preview_text: input.previewText ?? undefined,
            segment_id: input.segmentId ?? undefined,
            topic_id: input.topicId ?? undefined,
          }),
        ),
      ),
    deleteBroadcast: (broadcastId: string) =>
      write(() => id(api.delete(`/broadcasts/${broadcastId}`))),

    batchContacts,
    deleteContact: (contactId: string) =>
      write(async () => ({
        id: (await api.delete<{ contact: string }>(`/contacts/${contactId}`)).body.contact,
      })),
    /** Prefer inline `segments` on batch items; this is one request per contact. */
    addContactsToSegment: async (segmentId: string, contactIds: string[]) => {
      const added: string[] = [];
      const errors: { id: string; message: string }[] = [];
      for (const contactId of contactIds) {
        const result = await write(() =>
          id(api.post(`/contacts/${contactId}/segments/${segmentId}`)),
        );
        if (result.ok) added.push(result.id);
        else errors.push({ id: contactId, message: result.message });
      }
      return { added, errors };
    },

    /** Every suppression id on the target; apply diffs against it so rollback deletes only rows it added. */
    listSuppressionIds: async () =>
      (await listAll<{ id: string }>("/suppressions")).map((s) => s.id),
    addSuppressions: (emails: string[], origin: "bounce" | "complaint" | "manual") =>
      suppressionsBatch("/suppressions/batch/add", "emails", emails, { origin }),
    removeSuppressions: (ids: string[]) =>
      suppressionsBatch("/suppressions/batch/remove", "ids", ids),
  };
}

export type MillionSendTarget = ReturnType<typeof createMillionSendTarget>;
