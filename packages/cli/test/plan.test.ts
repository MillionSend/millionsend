import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESOURCES, type Resource, type Snapshot, type TargetState } from "../src/model.js";
import {
  buildPlan,
  type PlanOptions,
  parsePlan,
  planHash,
  renderPlan,
  serializePlan,
} from "../src/plan.js";
import { TARGET_WEBHOOK_EVENTS } from "../src/translate.js";

const snapshot: Snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"),
);

const emptyTarget: TargetState = {
  usage: {
    cloud: false,
    plan: null,
    limits: { emailsPerDay: null, domains: null },
    today: { emailsSent: 0 },
    appUrl: null,
  },
  domains: [],
  properties: [],
  topics: [],
  segments: [],
  webhooks: [],
  templates: [],
  broadcasts: [],
};

/** Every resource matched at least once, some differing, one verified domain, a tight domain limit. */
const goldenTarget: TargetState = {
  usage: {
    cloud: true,
    plan: "free",
    limits: { emailsPerDay: 100, domains: 1 },
    today: { emailsSent: 0 },
    appUrl: "https://app.millionsend.com",
  },
  domains: [
    { id: "d1", name: "example.com", region: "us-east-1", status: "verified", records: [] },
  ],
  properties: [{ id: "p1", key: "company", type: "string" }],
  topics: [
    {
      id: "t1",
      name: "Product updates",
      description: "Old description",
      defaultSubscription: "opt_in",
    },
  ],
  segments: [{ id: "s1", name: "Active Users", filter: null }],
  webhooks: [
    {
      id: "w1",
      endpoint: "https://webhook.example.com/handler",
      events: ["email.sent"],
      status: "enabled",
    },
  ],
  templates: [
    {
      id: "tp1",
      name: "Welcome (old)",
      alias: "welcome",
      subject: "Welcome, {{{FIRST_NAME|friend}}}",
      html: "<h1>Welcome {{{FIRST_NAME}}}</h1><p>{{{UNSUBSCRIBE_URL}}}</p>",
      text: null,
    },
  ],
  broadcasts: [],
};

const options = (overrides: Partial<PlanOptions> = {}): PlanOptions => ({
  include: new Set<Resource>(RESOURCES),
  includeSent: false,
  freshWebhookSecrets: false,
  rps: 8,
  sourceRequestsSpent: 40,
  baseUrl: "https://api.millionsend.com",
  now: new Date("2026-09-01T12:00:00Z"),
  ...overrides,
});

const GOLDEN = `Resource actions are indicated with the following symbols:
  + create
  ~ update
  = unchanged
  ! manual
  - skip

  = unchanged  properties/company
  + create     properties/seats — number
  ~ update     topics/Product updates (description)
  + create     topics/Beta program — opt_out
  ~ update     segments/Active Users (filter)
  + create     segments/Enterprise — 1 member
  ! manual     segments/Enterprise — filter not translated (unsupported field "plan_tier"); 1 member still imported
  + create     segments/Imported — 0 members
  = unchanged  domains/example.com
  + create     domains/updates.example.com — eu-west-1
  ! manual     domains/updates.example.com — add DNS records (shown after apply)
  ! manual     domains/mail.example.org — region ap-south-1 is not available (create it by hand in one of: us-east-1, eu-west-1, sa-east-1, ap-northeast-1)
  ~ update     webhooks/https://webhook.example.com/handler (events)
  ! manual     webhooks/https://webhook.example.com/handler — events not delivered here: email.suppressed
  ! manual     webhooks/https://hooks.example.com/contacts — none of its events exist here; not created
  ! manual     webhooks/https://hooks.example.com/contacts — events not delivered here: contact.created, contact.updated
  ~ update     templates/welcome (name)
  ! manual     templates/welcome — from Acme <onboarding@example.com> is not stored on templates; pass it when sending
  ! manual     templates/welcome — reply_to support@example.com is not stored on templates; pass it when sending
  ! manual     templates/welcome — variables first_name are not stored; merge fields resolve from contact properties
  + create     templates/Receipt
  ! manual     templates/Receipt — variables order_id are not stored; merge fields resolve from contact properties
  + create     contacts (5) — batch upsert, 3 segment memberships
  ~ update     enrichment (5) — properties and topic subscriptions, read per contact
  + create     broadcasts/November announcements — draft
  ! manual     broadcasts/Beta invite — from domain updates.example.com is not verified here — re-run apply after DNS verification
  - skip       broadcasts/Launch recap — already sent; --include-sent imports it as a draft
  + create     suppressions (3) — batch add with origin
  ! manual     api-keys/Production — create it by hand; Resend exposes only the name
  ! manual     api-keys/Staging — create it by hand; Resend exposes only the name

Plan: 9 to create, 5 to update, 2 unchanged, 13 manual, 1 skipped.
warning: 1 domain to create; the Free plan allows 1 (1 already there)
Estimate: ~64 requests · 3 s at 8 req/s
`;

describe("buildPlan + renderPlan (golden)", () => {
  const plan = buildPlan({ snapshot, target: goldenTarget, options: options() });

  it("renders exactly", () => {
    expect(renderPlan(plan)).toBe(GOLDEN);
  });

  it("counts, header and manual list agree with the items", () => {
    expect(plan.counts).toEqual({ create: 9, update: 5, unchanged: 2, manual: 13, skip: 1 });
    expect(plan).toMatchObject({
      version: 1,
      createdAt: "2026-09-01T12:00:00.000Z",
      source: "resend",
      target: { baseUrl: "https://api.millionsend.com", cloud: true, plan: "free" },
      rps: 8,
    });
    expect(plan.manual).toHaveLength(13);
    expect(plan.manual[0]).toEqual({
      title: "segments/Enterprise",
      detail: 'filter not translated (unsupported field "plan_tier"); 1 member still imported',
    });
  });

  it("estimates: spent + one read per contact per facet + writes; seconds count only what is ahead", () => {
    // writes: 7 creates + 4 updates + contacts batch + suppressions batch + enrichment batch = 14
    expect(plan.estimate).toEqual({ requests: 40 + 10 + 14, seconds: Math.ceil(10 / 8 + 14 / 10) });
    const topicsOnly = buildPlan({
      snapshot: { ...snapshot, properties: [] },
      target: goldenTarget,
      options: options(),
    });
    // One facet: 5 reads, one write fewer (the seats property is not created).
    expect(topicsOnly.estimate).toEqual({
      requests: 40 + 5 + 13,
      seconds: Math.ceil(5 / 8 + 13 / 10),
    });
  });

  it("carries typed payloads without secrets", () => {
    const byKey = (resource: Resource, key: string, action = "create") =>
      plan.items.find((i) => i.resource === resource && i.key === key && i.action === action);
    expect(byKey("properties", "seats")?.payload).toEqual({
      key: "seats",
      type: "number",
      fallback_value: 1,
    });
    expect(byKey("topics", "Beta program")?.payload).toEqual({
      name: "Beta program",
      default_subscription: "opt_out",
    });
    expect(byKey("topics", "Product updates", "update")).toMatchObject({
      targetId: "t1",
      payload: { description: "Feature announcements and release notes" },
    });
    expect(byKey("segments", "Active Users", "update")?.payload).toEqual({
      filter: {
        match: "all",
        conditions: [{ field: "email", op: "ends_with", value: "@example.com" }],
      },
    });
    expect(byKey("segments", "Enterprise")?.payload).toEqual({ name: "Enterprise" });
    expect(byKey("domains", "updates.example.com")?.payload).toEqual({
      create: { name: "updates.example.com", region: "eu-west-1", custom_return_path: "bounces" },
      tracking: { open_tracking: false, click_tracking: true, tracking_subdomain: "track" },
    });
    expect(byKey("webhooks", "https://webhook.example.com/handler", "update")?.payload).toEqual({
      events: ["email.sent", "email.delivered", "email.bounced"],
    });
    expect(byKey("templates", "welcome", "update")?.payload).toEqual({ name: "Welcome" });
    expect(byKey("templates", "Receipt")?.payload).toEqual({
      name: "Receipt",
      subject: "Your receipt",
      html: "<p>Order {{{order_id}}}</p>",
      text: "Order {{{order_id}}}",
    });
    expect(byKey("broadcasts", "November announcements")?.payload).toEqual({
      input: {
        name: "November announcements",
        from: "Acme <onboarding@example.com>",
        subject: "Hello World",
        html: '<p>Hello {{{FIRST_NAME|there}}}!</p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
        text: "Hello {{{FIRST_NAME|there}}}!",
        preview_text: "Here are our announcements",
      },
      segmentName: "Active Users",
      topicName: null,
    });
    expect(serializePlan(plan)).not.toContain("whsec_");
  });

  it("orders items by dependency", () => {
    const order = [...new Set(plan.items.map((i) => i.resource))];
    expect(order).toEqual([
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
    ]);
  });
});

describe("buildPlan against an empty target", () => {
  const plan = buildPlan({ snapshot, target: emptyTarget, options: options() });

  it("creates everything it can and copies webhook secrets", () => {
    // The only update is the enrichment pass; nothing exists to be unchanged.
    expect(plan.counts).toMatchObject({ update: 1, unchanged: 0 });
    expect(plan.warnings).toEqual([]);
    const webhook = plan.items.find((i) => i.resource === "webhooks" && i.action === "create");
    expect(webhook).toMatchObject({
      key: "https://webhook.example.com/handler",
      detail: "3 events, secret copied",
      payload: {
        endpoint: "https://webhook.example.com/handler",
        events: ["email.sent", "email.delivered", "email.bounced"],
        sourceId: "479e3145-dd38-476b-932c-529ceb705947",
        signingSecret: "copy",
      },
    });
    // No domain is verified on an empty target, so every broadcast waits for DNS.
    expect(plan.items.filter((i) => i.resource === "broadcasts").map((i) => i.action)).toEqual([
      "manual",
      "manual",
      "skip",
    ]);
  });

  it("--fresh-webhook-secrets mints new ones", () => {
    const fresh = buildPlan({
      snapshot,
      target: emptyTarget,
      options: options({ freshWebhookSecrets: true }),
    });
    expect(
      fresh.items.find((i) => i.resource === "webhooks" && i.action === "create"),
    ).toMatchObject({ detail: "3 events, fresh secret", payload: { signingSecret: "fresh" } });
  });

  it("--include-sent imports sent broadcasts as drafts once the domain is verified", () => {
    const verified: TargetState = {
      ...emptyTarget,
      domains: [
        { id: "d1", name: "example.com", region: "us-east-1", status: "verified", records: [] },
      ],
    };
    const plan = buildPlan({ snapshot, target: verified, options: options({ includeSent: true }) });
    const recap = plan.items.filter((i) => i.key === "Launch recap");
    expect(recap.map((i) => [i.action, i.detail])).toEqual([
      ["create", "draft"],
      ["manual", "already sent on Resend; imported as a draft"],
    ]);
  });

  it("honours the include set and skips enrichment when nothing enriches", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, properties: [], topics: [] },
      target: emptyTarget,
      options: options({ include: new Set<Resource>(["contacts", "enrichment", "suppressions"]) }),
    });
    expect(plan.items.map((i) => [i.resource, i.count])).toEqual([
      ["contacts", 5],
      ["suppressions", 3],
    ]);
    // No enrichment reads, no per-item writes: 40 + (1 + 1) writes; the 40 are already spent.
    expect(plan.estimate).toEqual({ requests: 42, seconds: Math.ceil(2 / 10) });
    expect(plan.items[0]?.detail).toBe("batch upsert, 0 segment memberships");
  });

  it("skips the enrichment item when the snapshot is already enriched", () => {
    const plan = buildPlan({
      snapshot: { ...snapshot, enriched: true },
      target: emptyTarget,
      options: options(),
    });
    expect(plan.items.some((i) => i.resource === "enrichment")).toBe(false);
  });
});

describe("buildPlan diffs against existing rows", () => {
  const withRows = (partial: Partial<TargetState>): TargetState => ({ ...emptyTarget, ...partial });
  const only = (resource: Resource) => new Set<Resource>([resource]);

  it("is unchanged when nothing differs", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        topics: [
          {
            id: "t1",
            name: "Product updates",
            description: "Feature announcements and release notes",
            defaultSubscription: "opt_in",
          },
          { id: "t2", name: "Beta program", description: null, defaultSubscription: "opt_out" },
        ],
      }),
      options: options({ include: only("topics") }),
    });
    expect(plan.items.map((i) => [i.action, i.key, i.targetId])).toEqual([
      ["unchanged", "Product updates", "t1"],
      ["unchanged", "Beta program", "t2"],
    ]);
  });

  it("flags an immutable difference as manual and still diffs the rest", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        topics: [
          { id: "t2", name: "Beta program", description: "x", defaultSubscription: "opt_in" },
        ],
        properties: [{ id: "p1", key: "seats", type: "string" }],
      }),
      options: options({ include: new Set<Resource>(["topics", "properties"]) }),
    });
    expect(plan.items.map((i) => [i.resource, i.action, i.key])).toEqual([
      ["properties", "create", "company"],
      ["properties", "manual", "seats"],
      ["topics", "create", "Product updates"],
      ["topics", "manual", "Beta program"],
      ["topics", "update", "Beta program"],
    ]);
  });

  it("narrows a target webhook subscribed to all seven events down to Resend's set", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        webhooks: [
          {
            id: "w1",
            endpoint: "https://webhook.example.com/handler",
            events: [...TARGET_WEBHOOK_EVENTS],
            status: "disabled",
          },
        ],
      }),
      options: options({ include: only("webhooks") }),
    });
    expect(plan.items[0]).toMatchObject({
      action: "update",
      detail: "events, status",
      payload: { events: ["email.sent", "email.delivered", "email.bounced"], status: "enabled" },
    });
  });

  const receiptBody = {
    subject: "Your receipt",
    html: "<p>Order {{{order_id}}}</p>",
    text: "Order {{{order_id}}}",
  };

  it("matches templates by alias before name and diffs the alias", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        templates: [
          { ...goldenTarget.templates[0], id: "a", name: "Welcome", alias: null },
          { id: "b", name: "Receipt", alias: "receipt", ...receiptBody },
        ],
      }),
      options: options({ include: only("templates") }),
    });
    const rows = plan.items.filter((i) => i.action !== "manual");
    expect(rows.map((i) => [i.action, i.key, i.targetId, i.detail, i.payload])).toEqual([
      ["update", "welcome", "a", "alias", { alias: "welcome" }],
      ["update", "Receipt", "b", "alias", { alias: null }],
    ]);
  });

  it("a body edited on Resend becomes an update carrying only the translated fields that differ", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        templates: [
          { id: "b", name: "Receipt", alias: null, ...receiptBody, html: "<p>old</p>", text: null },
        ],
      }),
      options: options({ include: only("templates") }),
    });
    expect(plan.items.find((i) => i.key === "Receipt")).toMatchObject({
      action: "update",
      detail: "html, text",
      payload: { html: "<p>Order {{{order_id}}}</p>", text: "Order {{{order_id}}}" },
    });
    const same = buildPlan({
      snapshot,
      target: withRows({ templates: [{ id: "b", name: "Receipt", alias: null, ...receiptBody }] }),
      options: options({ include: only("templates") }),
    });
    expect(same.items.find((i) => i.key === "Receipt")?.action).toBe("unchanged");
  });

  it("lists the target's DNS records for an existing unverified domain and warns on the plan limit", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        usage: { ...emptyTarget.usage, plan: "pro", limits: { emailsPerDay: 3000, domains: 2 } },
        domains: [
          {
            id: "d1",
            name: "example.com",
            region: "us-east-1",
            status: "pending",
            records: [
              { record: "DKIM", name: "millionsend._domainkey", type: "CNAME", value: "x" },
              { record: "SPF", name: "send", type: "MX", value: "y", priority: 10 },
              { record: "SPF", name: "send", type: "TXT", value: "z" },
            ],
          },
        ],
      }),
      options: options({ include: only("domains") }),
    });
    expect(plan.items.map((i) => [i.action, i.key, i.detail])).toEqual([
      ["unchanged", "example.com", undefined],
      ["manual", "example.com", "add 3 DNS records"],
      ["create", "updates.example.com", "eu-west-1"],
      ["manual", "updates.example.com", "add DNS records (shown after apply)"],
      ["manual", "mail.example.org", expect.stringContaining("region ap-south-1")],
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("warns when creates exceed the domain limit; a self-hosted target never warns", () => {
    const cloud = buildPlan({
      snapshot: { ...snapshot, domains: snapshot.domains.slice(0, 2) },
      target: withRows({
        usage: {
          ...emptyTarget.usage,
          cloud: true,
          plan: "free",
          limits: { emailsPerDay: 100, domains: 1 },
        },
      }),
      options: options({ include: only("domains") }),
    });
    expect(cloud.warnings).toEqual([
      "2 domains to create; the Free plan allows 1 (0 already there)",
    ]);
    const selfHosted = buildPlan({
      snapshot,
      target: emptyTarget,
      options: options({ include: only("domains") }),
    });
    expect(selfHosted.warnings).toEqual([]);
  });

  it("leaves an existing draft broadcast alone", () => {
    const plan = buildPlan({
      snapshot,
      target: withRows({
        domains: [
          { id: "d1", name: "example.com", region: "us-east-1", status: "verified", records: [] },
        ],
        broadcasts: [
          { id: "b1", name: "November announcements", status: "draft" },
          { id: "b2", name: "Beta invite", status: "sent" },
        ],
      }),
      options: options({ include: only("broadcasts") }),
    });
    expect(plan.items.map((i) => [i.action, i.key])).toEqual([
      ["unchanged", "November announcements"],
      ["manual", "Beta invite"],
      ["skip", "Launch recap"],
    ]);
    expect(renderPlan(plan)).toContain(
      "= unchanged  broadcasts/November announcements — matched by name; the draft's body is not compared",
    );
  });

  it("renders source-controlled names without their control and escape sequences", () => {
    const hostile = "News\x1b]52;c;cHduZWQ=\x07\x1b[2J\x00";
    const plan = buildPlan({
      snapshot: {
        ...snapshot,
        topics: [
          {
            id: "t-hostile",
            name: hostile,
            description: `${hostile} desc`,
            defaultSubscription: "opt_in",
          },
        ],
      },
      target: emptyTarget,
      options: options({ include: only("topics") }),
    });
    const text = renderPlan(plan);
    expect(text).toContain("+ create     topics/News — opt_in");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
    expect(text).not.toContain("\x00");
  });
});

describe("planHash / serializePlan / parsePlan", () => {
  const plan = buildPlan({ snapshot, target: goldenTarget, options: options() });

  it("hashes the items only, independent of key order and timestamps", () => {
    const hash = planHash(plan);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(planHash({ ...plan, createdAt: "2000-01-01T00:00:00.000Z" })).toBe(hash);
    const reordered = {
      ...plan,
      items: plan.items.map((i) => ({ ...i, key: i.key, resource: i.resource })),
    };
    expect(planHash(reordered)).toBe(hash);
    expect(planHash({ ...plan, items: plan.items.slice(1) })).not.toBe(hash);
  });

  it("round-trips through JSON", () => {
    const text = serializePlan(plan);
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = parsePlan(text);
    expect(parsed).toEqual(plan);
    expect(planHash(parsed)).toBe(planHash(plan));
  });

  it.each([
    ["{", "plan file is not valid JSON"],
    ["null", "plan file is not a migration plan"],
    ['{"version":1}', "plan file is not a migration plan"],
    ['{"version":2,"items":[]}', "plan file version 2 is not supported (expected 1)"],
    ['{"items":[]}', "plan file version undefined is not supported (expected 1)"],
  ])("rejects %s", (text, message) => {
    expect(() => parsePlan(text)).toThrow(message);
  });
});

describe("renderPlan colours", () => {
  it("wraps only the symbol and action when color is on", () => {
    const plan = buildPlan({
      snapshot,
      target: emptyTarget,
      options: options({ include: new Set<Resource>(["suppressions"]) }),
    });
    const line = renderPlan(plan, { color: true })
      .split("\n")
      .find((l) => l.includes("suppressions (3)"));
    expect(line).toBe("  \x1b[32m+ create   \x1b[39m  suppressions (3) — batch add with origin");
  });
});
