import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError, createHttp } from "../src/http.js";
import { createLogger } from "../src/log.js";
import { VERSION } from "../src/meta.js";
import {
  BATCH_MAX,
  createMillionSendTarget,
  type MillionSendTarget,
  type WriteResult,
} from "../src/millionsend.js";
import type { Snapshot } from "../src/model.js";
import { buildPlan } from "../src/plan.js";
import { TARGET_WEBHOOK_EVENTS } from "../src/translate.js";
import { createApiKey, type LiveApi, startLiveApi } from "./helpers/live-api.js";

let cloud: LiveApi;
let selfHost: LiveApi;
let target: MillionSendTarget;

const log = createLogger({ level: "error" });

function targetFor(
  api: Pick<LiveApi, "baseUrl" | "apiKey">,
  token = api.apiKey,
): MillionSendTarget {
  return createMillionSendTarget(
    createHttp({
      baseUrl: api.baseUrl,
      token,
      userAgent: "millionsend-cli/test",
      rps: 1000,
      name: "MillionSend",
      log,
    }),
    log,
    api.baseUrl,
  );
}

function ok<T>(result: WriteResult<T>): T {
  if (!result.ok) throw new Error(`${result.status} ${result.name}: ${result.message}`);
  return result;
}

const ids = {} as Record<
  | "property"
  | "numberProperty"
  | "topic"
  | "privateTopic"
  | "segment"
  | "filteredSegment"
  | "domain"
  | "webhook"
  | "webhook2"
  | "template"
  | "broadcast"
  | "ada"
  | "bob"
  | "suppression"
  | "suppression2",
  string
>;

beforeAll(async () => {
  [cloud, selfHost] = await Promise.all([
    startLiveApi({ isCloud: true, appBaseUrl: "https://app.example.test" }),
    startLiveApi({ isCloud: false, slug: "selfhost" }),
  ]);
  target = targetFor(cloud);
});
afterAll(() => Promise.all([cloud.stop(), selfHost.stop()]));

describe("probe", () => {
  it("reads the plan and limits on Cloud", async () => {
    expect(await target.probe()).toEqual({
      cloud: true,
      plan: "free",
      limits: { emailsPerDay: 100, domains: 3 },
      today: { emailsSent: 0 },
      appUrl: "https://app.example.test",
    });
    expect(target.requests).toBe(1);
  });

  it("reads null plan and limits self-hosted", async () => {
    expect(await targetFor(selfHost).probe()).toEqual({
      cloud: false,
      plan: null,
      limits: { emailsPerDay: null, domains: null },
      today: { emailsSent: 0 },
      appUrl: null,
    });
  });

  it("is an AuthError naming the full-access requirement on 403 and 401", async () => {
    const sendingKey = await createApiKey(cloud.db, cloud.teamId, "sending_access");
    const restricted = await targetFor(cloud, sendingKey)
      .probe()
      .catch((e: unknown) => e);
    expect(restricted).toBeInstanceOf(AuthError);
    expect((restricted as AuthError).status).toBe(403);
    expect((restricted as Error).message).toContain("full-access key (ms_…)");
    expect((restricted as Error).message).toContain("MILLIONSEND_API_KEY");

    const wrong = await targetFor(cloud, "ms_not_a_key")
      .probe()
      .catch((e: unknown) => e);
    expect(wrong).toMatchObject({ status: 401 });
    expect((wrong as Error).message).toContain("full-access key (ms_…)");
  });

  it("names the URL and the upgrade path when the instance has no GET /usage", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "not_found", message: "no route" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const error = (await targetFor({ baseUrl, apiKey: "ms_x" })
        .probe()
        .catch((e: unknown) => e)) as Error;
      expect(error.message).toBe(
        `MillionSend at ${baseUrl} has no GET /usage: either ${baseUrl} is not the API URL of your instance (check --to-url / MILLIONSEND_BASE_URL) or the instance predates CLI ${VERSION}; upgrade it.`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("writers", () => {
  it("creates properties, topics, segments and maps duplicates/validation to ok:false", async () => {
    ids.property = ok(await target.createProperty({ key: "plan", type: "string" })).id;
    ids.numberProperty = ok(
      await target.createProperty({ key: "seats", type: "number", fallbackValue: 1 }),
    ).id;
    expect(await target.createProperty({ key: "plan", type: "string" })).toEqual({
      ok: false,
      status: 409,
      name: "validation_error",
      message: "Property already exists",
    });

    ids.topic = ok(
      await target.createTopic({
        name: "Product news",
        description: "Launches",
        defaultSubscription: "opt_in",
      }),
    ).id;
    ids.privateTopic = ok(
      await target.createTopic({ name: "Ops", description: null, defaultSubscription: "opt_out" }),
    ).id;
    expect(await target.createTopic({ name: "", defaultSubscription: "opt_in" })).toMatchObject({
      ok: false,
      status: 422,
      name: "validation_error",
    });
    expect(await target.updateTopic(ids.topic, { description: "Launches and changelogs" })).toEqual(
      {
        ok: true,
        id: ids.topic,
      },
    );
    expect(
      await target.updateTopic("00000000-0000-4000-8000-000000000000", { name: "x" }),
    ).toMatchObject({ ok: false, status: 404, name: "not_found" });

    ids.segment = ok(await target.createSegment({ name: "Customers" })).id;
    ids.filteredSegment = ok(
      await target.createSegment({
        name: "Pro",
        filter: {
          match: "all",
          conditions: [{ field: "property:plan", op: "equals", value: "pro" }],
        },
      }),
    ).id;
    expect(await target.updateSegment(ids.segment, { name: "Paying customers" })).toEqual({
      ok: true,
      id: ids.segment,
    });
    expect(
      await target.createSegment({
        name: "Bad",
        filter: { match: "all", conditions: [{ field: "nope", op: "equals", value: "x" }] },
      }),
    ).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it("creates a domain with records, patches tracking, and 409s a duplicate", async () => {
    const created = ok(
      await target.createDomain({
        name: "acme.dev",
        customReturnPath: "mail",
      }),
    );
    ids.domain = created.id;
    expect(created.records.map((r) => r.record)).toEqual(
      expect.arrayContaining(["DKIM", "SPF", "DMARC"]),
    );
    expect(created.records.find((r) => r.record === "SPF")?.name).toBe("mail.acme.dev");

    const patched = ok(
      await target.updateDomainTracking(ids.domain, {
        openTracking: true,
        clickTracking: true,
        trackingSubdomain: "track",
      }),
    );
    expect(patched.id).toBe(ids.domain);
    expect(patched.records.find((r) => r.record === "Tracking")?.name).toBe("track.acme.dev");

    expect(await target.createDomain({ name: "acme.dev" })).toEqual({
      ok: false,
      status: 409,
      name: "conflict",
      message: "domain already added",
    });
    expect(await target.createDomain({ name: "Not A Domain" })).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it("creates webhooks copying or minting the secret, updates, and 422s http endpoints", async () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const copied = ok(
      await target.createWebhook({
        endpoint: "https://hooks.example.test/a",
        events: ["email.delivered", "email.bounced"],
        signingSecret: secret,
      }),
    );
    ids.webhook = copied.id;
    expect(copied.signingSecret).toBe(secret);

    const fresh = ok(
      await target.createWebhook({
        endpoint: "https://hooks.example.test/b",
        events: ["email.sent"],
      }),
    );
    ids.webhook2 = fresh.id;
    expect(fresh.signingSecret).toMatch(/^whsec_/);
    expect(fresh.signingSecret).not.toBe(secret);

    expect(
      await target.updateWebhook(ids.webhook, { events: ["email.opened"], status: "disabled" }),
    ).toEqual({ ok: true, id: ids.webhook });
    expect(
      await target.createWebhook({ endpoint: "http://plain.example.test", events: ["email.sent"] }),
    ).toMatchObject({ ok: false, status: 422, name: "validation_error" });
    expect(
      await target.createWebhook({
        endpoint: "https://hooks.example.test/c",
        events: ["domain.created"],
      }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it("creates and updates templates by alias, 409s a taken alias", async () => {
    ids.template = ok(
      await target.createTemplate({
        name: "Welcome",
        alias: "welcome",
        subject: "Hi {{{FIRST_NAME|there}}}",
        html: "<p>Welcome</p>",
        text: null,
      }),
    ).id;
    expect(await target.updateTemplate("welcome", { html: "<p>Welcome back</p>" })).toEqual({
      ok: true,
      id: ids.template,
    });
    expect(
      await target.createTemplate({ name: "Welcome 2", alias: "welcome", html: "<p>x</p>" }),
    ).toEqual({
      ok: false,
      status: 409,
      name: "validation_error",
      message: "Template alias already exists",
    });
    expect(await target.updateTemplate("nope", { name: "x" })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("creates a draft broadcast and 422s a missing body", async () => {
    ids.broadcast = ok(
      await target.createBroadcast({
        name: "Launch",
        from: "News <news@acme.dev>",
        subject: "We launched",
        html: "<p>Hello {{{UNSUBSCRIBE_URL}}}</p>",
        replyTo: ["reply@acme.dev"],
        segmentId: ids.segment,
        topicId: ids.topic,
        previewText: null,
      }),
    ).id;
    expect(
      await target.createBroadcast({ from: "news@acme.dev", subject: "No body" }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it("batch upserts contacts with inline associations, re-runs as updates, records per-item errors", async () => {
    const items = [
      {
        email: "ada@example.com",
        first_name: "Ada",
        unsubscribed: false,
        properties: { plan: "pro", seats: 3 },
        segments: [{ id: ids.segment }],
        topics: [{ id: ids.topic, subscription: "opt_out" as const }],
      },
      { email: "bob@example.com", last_name: "B", unsubscribed: true },
      { email: "not-an-email" },
    ];
    const first = await target.batchContacts(items, { onConflict: "upsert" });
    expect(first.data.map((d) => [d.index, d.status])).toEqual([
      [0, "created"],
      [1, "created"],
    ]);
    expect(first.counts).toEqual({ created: 2, updated: 0, skipped: 0, failed: 1 });
    expect(first.errors).toEqual([{ index: 2, message: expect.stringMatching(/^email: /) }]);
    ids.ada = first.data[0]?.id ?? "";
    ids.bob = first.data[1]?.id ?? "";

    const again = await target.batchContacts(items.slice(0, 2), { onConflict: "upsert" });
    expect(again.data.map((d) => [d.index, d.id, d.status])).toEqual([
      [0, ids.ada, "updated"],
      [1, ids.bob, "updated"],
    ]);
    expect(again.counts).toEqual({ created: 0, updated: 2, skipped: 0, failed: 0 });
    expect(again.errors).toEqual([]);

    const skipped = await target.batchContacts(items.slice(0, 1), { onConflict: "skip" });
    expect(skipped.counts).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0 });

    const addToSegment = await target.addContactsToSegment(ids.filteredSegment, [
      ids.ada,
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(addToSegment.added).toEqual([ids.ada]);
    expect(addToSegment.errors).toEqual([
      { id: "00000000-0000-4000-8000-000000000000", message: "Contact not found" },
    ]);
  });

  it("splits contacts into chunks of 1000 with indices over the whole input", async () => {
    const many = Array.from({ length: BATCH_MAX + 2 }, (_, i) => ({
      email: i === BATCH_MAX + 1 ? "broken" : `bulk-${i}@example.com`,
    }));
    const before = target.requests;
    const out = await target.batchContacts(many, { onConflict: "upsert" });
    expect(target.requests - before).toBe(2);
    expect(out.counts).toEqual({ created: BATCH_MAX + 1, updated: 0, skipped: 0, failed: 1 });
    expect(out.data).toHaveLength(BATCH_MAX + 1);
    expect(out.data.at(-1)?.index).toBe(BATCH_MAX);
    expect(out.errors).toEqual([
      { index: BATCH_MAX + 1, message: expect.stringMatching(/^email/) },
    ]);
  }, 60_000);

  it("adds suppressions with their origin in one request per 1000 and lists them back", async () => {
    const out = await target.addSuppressions(
      ["bounced@example.com", "Bounced@example.com", "gone@example.com"],
      "bounce",
    );
    expect(out.ids).toHaveLength(2);
    expect(out.errors).toEqual([]);
    ids.suppression = out.ids[0] ?? "";
    ids.suppression2 = out.ids[1] ?? "";

    const bad = await target.addSuppressions(["nope"], "manual");
    expect(bad.ids).toEqual([]);
    expect(bad.errors).toEqual([{ index: 0, message: expect.stringMatching(/emails/) }]);

    const listed = await fetch(`${cloud.baseUrl}/suppressions?origin=bounce`, {
      headers: { authorization: `Bearer ${cloud.apiKey}` },
    });
    const body = (await listed.json()) as { data: { email: string; origin: string }[] };
    expect(body.data.map((s) => s.email).sort()).toEqual([
      "bounced@example.com",
      "gone@example.com",
    ]);
  });
});

describe("readState", () => {
  it("lists every resource with domain records and template bodies, paging past 100 rows", async () => {
    for (let i = 0; i < 101; i++) {
      ok(await target.createSegment({ name: `page-${i}` }));
    }
    // A dashboard-created endpoint: events null on the wire means every event.
    await cloud.db
      .update(schema.webhookEndpoints)
      .set({ events: null })
      .where(eq(schema.webhookEndpoints.id, ids.webhook2));
    const state = await target.readState();
    expect(state.usage.plan).toBe("free");
    expect(state.domains).toEqual([
      {
        id: ids.domain,
        name: "acme.dev",
        region: "us-east-1",
        status: "pending",
        records: expect.arrayContaining([
          expect.objectContaining({ record: "DKIM", type: "TXT" }),
          expect.objectContaining({ record: "Tracking", name: "track.acme.dev" }),
        ]),
      },
    ]);
    expect(state.properties).toEqual([
      { id: ids.property, key: "plan", type: "string" },
      { id: ids.numberProperty, key: "seats", type: "number" },
    ]);
    expect(state.topics).toEqual([
      {
        id: ids.topic,
        name: "Product news",
        description: "Launches and changelogs",
        defaultSubscription: "opt_in",
      },
      { id: ids.privateTopic, name: "Ops", description: null, defaultSubscription: "opt_out" },
    ]);
    expect(state.segments).toHaveLength(103);
    expect(state.segments.slice(0, 2)).toEqual([
      { id: ids.segment, name: "Paying customers", filter: null },
      expect.objectContaining({ id: ids.filteredSegment, name: "Pro" }),
    ]);
    expect(new Set(state.segments.map((s) => s.id)).size).toBe(103);
    expect(state.webhooks).toEqual([
      {
        id: ids.webhook,
        endpoint: "https://hooks.example.test/a",
        events: ["email.opened"],
        status: "disabled",
      },
      {
        id: ids.webhook2,
        endpoint: "https://hooks.example.test/b",
        events: [...TARGET_WEBHOOK_EVENTS],
        status: "enabled",
      },
    ]);
    expect(state.templates).toEqual([
      {
        id: ids.template,
        name: "Welcome",
        alias: "welcome",
        subject: "Hi {{{FIRST_NAME|there}}}",
        html: "<p>Welcome back</p>",
        text: null,
      },
    ]);
    expect(state.broadcasts).toEqual([{ id: ids.broadcast, name: "Launch", status: "draft" }]);

    // Through the plan: a Resend webhook on every target event matches it, no narrowing PATCH.
    const snapshot: Snapshot = {
      provider: "resend",
      takenAt: "2026-09-01T00:00:00.000Z",
      domains: [],
      apiKeys: [],
      properties: [],
      topics: [],
      segments: [],
      contacts: [],
      broadcasts: [],
      templates: [],
      webhooks: [
        {
          id: "src-b",
          endpoint: "https://hooks.example.test/b",
          events: [...TARGET_WEBHOOK_EVENTS],
          status: "enabled",
          signingSecret: null,
        },
      ],
      suppressions: [],
      metrics: { emailsLast30Days: null },
      enriched: false,
    };
    const plan = buildPlan({
      snapshot,
      target: state,
      options: {
        include: new Set(["webhooks"]),
        includeSent: false,
        freshWebhookSecrets: false,
        rps: 8,
        sourceRequestsSpent: 0,
        baseUrl: cloud.baseUrl,
      },
    });
    expect(plan.items).toEqual([
      {
        resource: "webhooks",
        action: "unchanged",
        key: "https://hooks.example.test/b",
        targetId: ids.webhook2,
      },
    ]);
  });
});

describe("rollback deletes", () => {
  it("deletes each created resource once; a second delete is ok:false 404", async () => {
    expect(await target.deleteBroadcast(ids.broadcast)).toEqual({
      ok: true,
      id: ids.broadcast,
    });
    expect(await target.deleteTemplate(ids.template)).toEqual({
      ok: true,
      id: ids.template,
    });
    expect(await target.deleteWebhook(ids.webhook)).toEqual({
      ok: true,
      id: ids.webhook,
    });
    expect(await target.deleteContact(ids.ada)).toEqual({ ok: true, id: ids.ada });
    expect(await target.deleteContact(ids.ada)).toMatchObject({
      ok: false,
      status: 404,
      name: "not_found",
      message: "Contact not found",
    });
    expect(await target.deleteSegment(ids.filteredSegment)).toEqual({
      ok: true,
      id: ids.filteredSegment,
    });
    expect(await target.deleteTopic(ids.privateTopic)).toEqual({
      ok: true,
      id: ids.privateTopic,
    });
    expect(await target.deleteProperty(ids.property)).toEqual({
      ok: true,
      id: ids.property,
    });
    expect(await target.deleteDomain(ids.domain)).toEqual({ ok: true, id: ids.domain });
    expect(await target.deleteDomain(ids.domain)).toMatchObject({
      ok: false,
      status: 404,
    });

    const removed = await target.removeSuppressions([
      ids.suppression,
      ids.suppression2,
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(removed.ids.sort()).toEqual([ids.suppression, ids.suppression2].sort());
    expect(removed.errors).toEqual([]);

    const state = await target.readState();
    expect(state.domains).toEqual([]);
    expect(state.templates).toEqual([]);
    expect(state.broadcasts).toEqual([]);
    expect(state.webhooks.map((w) => w.id)).toEqual([ids.webhook2]);
    expect(state.topics.map((t) => t.id)).toEqual([ids.topic]);
    expect(state.properties.map((p) => p.id)).toEqual([ids.numberProperty]);
  });
});
