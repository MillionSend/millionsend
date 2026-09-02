import type { FakeContact, FakeResendData, FakeSegment, Row } from "./fake-resend.js";

/** Deterministic uuid-shaped id: the kind in the first group, the index in the last. */
export const fakeId = (kind: number, n: number): string =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const KIND = {
  domain: 1,
  topic: 2,
  property: 3,
  segment: 4,
  contact: 5,
  broadcast: 6,
  template: 7,
  webhook: 8,
  suppression: 9,
  apiKey: 10,
} as const;

export const CONTACT_COUNT = 1250;

export const TOPICS = [
  {
    name: "Product updates",
    description: "New features and changes",
    default_subscription: "opt_in",
    visibility: "public",
  },
  {
    name: "Newsletter",
    description: "Monthly digest",
    default_subscription: "opt_out",
    visibility: "private",
  },
  { name: "Changelog", default_subscription: "opt_in", visibility: "public" },
  {
    name: "Offers",
    description: "Discounts and promotions",
    default_subscription: "opt_out",
    visibility: "public",
  },
  { name: "Security notices", default_subscription: "opt_in", visibility: "private" },
] as const;

/** Explicit memberships as [from, to) contact index ranges; the first two overlap on 200..399. */
export const SEGMENTS = [
  {
    name: "Active Users",
    filter: {
      match: "all",
      conditions: [{ field: "properties.plan", op: "equals", value: "pro" }],
    },
    members: [0, 400],
  },
  { name: "Beta testers", members: [200, 500] },
  { name: "Enterprise", members: [1000, CONTACT_COUNT] },
] as const;

export const API_KEY_NAMES = ["Production", "Staging", "CI", "Marketing site"] as const;

/** whsec_ + base64 of 32 bytes: the shape the target accepts on POST /webhooks. */
export const WEBHOOK_SECRETS = [
  `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
  `whsec_${Buffer.alloc(32, 9).toString("base64")}`,
] as const;

export const WEBHOOK_ENDPOINTS = [
  "https://hooks.example.com/email",
  "https://hooks.example.com/crm",
] as const;

export const SUPPRESSIONS = { bounce: 20, complaint: 12, manual: 8 } as const;

export const EMAILS_SENT_30D = 41208;

const FIRST = ["Ada", "Grace", "Linus", "Margaret", "Ken", "Barbara"];
const LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov"];

export const contactEmail = (i: number): string =>
  `user${String(i + 1).padStart(4, "0")}@${i % 7 === 0 ? "example.net" : "example.org"}`;

const topicRef = (index: number, subscription: "opt_in" | "opt_out") => ({
  id: fakeId(KIND.topic, index),
  name: TOPICS[index]?.name ?? "",
  description: (TOPICS[index] as { description?: string }).description ?? null,
  subscription,
});

/** Every third contact carries properties, every other one topic overrides, every tenth is unsubscribed. */
export function contactSeed(i: number): FakeContact {
  const properties =
    i % 3 === 0
      ? { plan: i % 2 === 0 ? "pro" : "free", seats: (i % 9) + 1, company: `Company ${i}` }
      : i % 3 === 1
        ? { plan: "free" }
        : {};
  const topics =
    i % 4 === 0
      ? [topicRef(0, "opt_in"), topicRef(1, "opt_out")]
      : i % 4 === 2
        ? [topicRef(2, "opt_out")]
        : [];
  return {
    id: fakeId(KIND.contact, i),
    email: contactEmail(i),
    first_name: i % 5 === 0 ? null : (FIRST[i % FIRST.length] ?? null),
    last_name: i % 3 === 0 ? null : (LAST[i % LAST.length] ?? null),
    created_at: `2025-${String((i % 12) + 1).padStart(2, "0")}-01 09:00:00.000+00`,
    unsubscribed: i % 10 === 9,
    properties,
    topics,
  };
}

/** Contacts the enrichment pass has something to send for (properties or topic overrides). */
export const enrichable = (): number =>
  Array.from({ length: CONTACT_COUNT }, (_, i) => contactSeed(i)).filter(
    (c) => Object.keys(c.properties ?? {}).length > 0 || (c.topics?.length ?? 0) > 0,
  ).length;

const record = (
  record: string,
  name: string,
  type: string,
  value: string,
  status: string,
  priority?: number,
): Row => ({
  id: `${name}-${type}`,
  record,
  name,
  type,
  ttl: "Auto",
  status,
  value,
  ...(priority === undefined ? {} : { priority }),
});

const HTML =
  '<p>Hi {{{contact.first_name|there}}},</p><p>News from Acme.</p><p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>';
const TEXT = "Hi {{{contact.first_name|there}}}, news from Acme. {{{RESEND_UNSUBSCRIBE_URL}}}";

/**
 * A mid-sized Resend account: three domains (one custom return path), four
 * API keys, three properties, five topics, three overlapping segments,
 * 1,250 contacts, six broadcasts, four templates, two webhooks, forty
 * suppressions and thirty days of metrics.
 */
export function realisticAccount(): FakeResendData {
  const domains: Row[] = [
    {
      id: fakeId(KIND.domain, 0),
      name: "example.com",
      status: "verified",
      created_at: "2023-04-26 20:21:26.347412+00",
      region: "us-east-1",
      open_tracking: true,
      click_tracking: true,
      tracking_subdomain: "track",
      capabilities: { sending: "enabled", receiving: "disabled" },
      records: [
        record(
          "DKIM",
          "resend._domainkey",
          "TXT",
          "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCexample",
          "verified",
        ),
        record("SPF", "send", "MX", "feedback-smtp.us-east-1.amazonses.com", "verified", 10),
        record("SPF", "send", "TXT", "v=spf1 include:amazonses.com ~all", "verified"),
        record("Tracking", "track", "CNAME", "track.resend.com", "verified"),
      ],
    },
    {
      id: fakeId(KIND.domain, 1),
      name: "news.example.com",
      status: "pending",
      created_at: "2024-01-15 10:00:00.000+00",
      region: "eu-west-1",
      open_tracking: false,
      click_tracking: false,
      capabilities: { sending: "enabled", receiving: "disabled" },
      records: [
        record(
          "DKIM",
          "resend._domainkey.news",
          "TXT",
          "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCother",
          "pending",
        ),
        record("SPF", "mail.news", "MX", "feedback-smtp.eu-west-1.amazonses.com", "pending", 10),
        record("SPF", "mail.news", "TXT", "v=spf1 include:amazonses.com ~all", "pending"),
      ],
    },
    {
      id: fakeId(KIND.domain, 2),
      name: "updates.example.com",
      status: "verified",
      created_at: "2024-08-02 08:00:00.000+00",
      region: "us-east-1",
      open_tracking: false,
      click_tracking: true,
      capabilities: { sending: "enabled", receiving: "disabled" },
      records: [
        record(
          "DKIM",
          "resend._domainkey.updates",
          "TXT",
          "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCthird",
          "verified",
        ),
        record(
          "SPF",
          "bounces.updates",
          "MX",
          "feedback-smtp.us-east-1.amazonses.com",
          "verified",
          10,
        ),
        record("SPF", "bounces.updates", "TXT", "v=spf1 include:amazonses.com ~all", "verified"),
      ],
    },
  ];

  const api_keys: Row[] = API_KEY_NAMES.map((name, i) => ({
    id: fakeId(KIND.apiKey, i),
    name,
    created_at: `2024-0${i + 1}-01 00:00:00.000+00`,
    last_used_at: i === 0 ? "2026-08-30 12:00:00.000+00" : null,
  }));

  const contact_properties: Row[] = [
    {
      id: fakeId(KIND.property, 0),
      key: "plan",
      type: "string",
      fallback_value: "free",
      created_at: "2024-02-01 09:00:00.000+00",
    },
    {
      id: fakeId(KIND.property, 1),
      key: "seats",
      type: "number",
      fallback_value: 1,
      created_at: "2024-02-01 09:01:00.000+00",
    },
    {
      id: fakeId(KIND.property, 2),
      key: "company",
      type: "string",
      created_at: "2024-02-01 09:02:00.000+00",
    },
  ];

  const topics: Row[] = TOPICS.map((t, i) => ({
    id: fakeId(KIND.topic, i),
    ...t,
    created_at: `2024-03-${String(i + 1).padStart(2, "0")} 08:30:00.000+00`,
  }));

  const contacts: FakeContact[] = Array.from({ length: CONTACT_COUNT }, (_, i) => contactSeed(i));

  const segments: FakeSegment[] = SEGMENTS.map((s, i) => ({
    id: fakeId(KIND.segment, i),
    name: s.name,
    created_at: `2024-04-0${i + 1} 10:00:00.000+00`,
    ...("filter" in s ? { filter: s.filter } : {}),
    member_ids: Array.from({ length: s.members[1] - s.members[0] }, (_, n) =>
      fakeId(KIND.contact, s.members[0] + n),
    ),
  }));

  const broadcast = (
    i: number,
    name: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): Row => ({
    id: fakeId(KIND.broadcast, i),
    name,
    audience_id: null,
    segment_id: null,
    from: "Acme <hello@example.com>",
    subject: "Hello {{{contact.first_name|there}}}",
    reply_to: [],
    preview_text: null,
    status,
    created_at: `2025-0${i + 1}-01 09:00:00.000+00`,
    scheduled_at: null,
    sent_at: status === "sent" ? `2025-0${i + 1}-02 10:00:00.000+00` : null,
    html: HTML,
    text: TEXT,
    topic_id: null,
    ...extra,
  });
  const broadcasts: Row[] = [
    broadcast(0, "Welcome series #1", "draft", {
      segment_id: fakeId(KIND.segment, 0),
      topic_id: fakeId(KIND.topic, 0),
      preview_text: "A warm welcome",
    }),
    broadcast(1, "Feature drop", "draft", { reply_to: ["support@example.com"] }),
    broadcast(2, "Spring sale", "scheduled", {
      scheduled_at: "2026-09-15 10:00:00.000+00",
      topic_id: fakeId(KIND.topic, 3),
      html: `${HTML}<p>Deals near {{{contact.address.city|your city}}}.</p>`,
    }),
    broadcast(3, "Launch day", "sent"),
    broadcast(4, "Q2 recap", "sent"),
    broadcast(5, "Summer update", "sent"),
  ];

  const template = (i: number, name: string, extra: Record<string, unknown> = {}): Row => ({
    id: fakeId(KIND.template, i),
    current_version_id: fakeId(KIND.template, 100 + i),
    name,
    alias: null,
    from: null,
    subject: `${name} from Acme`,
    reply_to: null,
    html: `<h1>${name}</h1><p>Hello {{{contact.first_name|there}}}</p>`,
    text: `${name}. Hello {{{contact.first_name|there}}}`,
    variables: [],
    status: "published",
    published_at: "2024-05-01 00:00:00.000+00",
    created_at: "2024-05-01 00:00:00.000+00",
    updated_at: "2024-05-01 00:00:00.000+00",
    has_unpublished_versions: false,
    ...extra,
  });
  const templates: Row[] = [
    template(0, "Welcome", {
      alias: "welcome",
      from: "Acme <hello@example.com>",
      subject: "Welcome, {{{first_name}}}",
      html: "<h1>Welcome, {{{first_name}}}</h1><p>You have {{{credits}}} credits.</p>",
      text: "Welcome, {{{first_name}}}",
      variables: [
        { id: "v1", key: "first_name", type: "string", fallback_value: "there" },
        { id: "v2", key: "credits", type: "number", fallback_value: 10 },
        { id: "v3", key: "flags", type: "object", fallback_value: { beta: true } },
      ],
    }),
    template(1, "Receipt", {
      from: "Acme Billing <billing@example.com>",
      reply_to: ["support@example.com"],
    }),
    template(2, "Password reset", { alias: "password-reset" }),
    template(3, "Digest"),
  ];

  const webhooks: Row[] = [
    {
      id: fakeId(KIND.webhook, 0),
      endpoint: WEBHOOK_ENDPOINTS[0],
      events: ["email.sent", "email.delivered", "email.bounced", "email.complained"],
      status: "enabled",
      created_at: "2024-06-01 00:00:00.000+00",
      signing_secret: WEBHOOK_SECRETS[0],
    },
    {
      id: fakeId(KIND.webhook, 1),
      endpoint: WEBHOOK_ENDPOINTS[1],
      events: ["email.opened", "email.clicked", "contact.created", "contact.updated"],
      status: "enabled",
      created_at: "2024-06-02 00:00:00.000+00",
      signing_secret: WEBHOOK_SECRETS[1],
    },
  ];

  const suppressions: Row[] = [];
  for (const [origin, n] of Object.entries(SUPPRESSIONS)) {
    for (let i = 0; i < n; i++) {
      suppressions.push({
        id: fakeId(KIND.suppression, suppressions.length),
        email: `${origin}${String(i + 1).padStart(2, "0")}@example.org`,
        origin,
        source_id: null,
        created_at: "2025-07-01 00:00:00.000+00",
      });
    }
  }

  return {
    domains,
    api_keys,
    contact_properties,
    topics,
    segments,
    contacts,
    broadcasts,
    templates,
    webhooks,
    suppressions,
    metrics: { sent: EMAILS_SENT_30D, delivered: 40511, bounced: 302, complained: 4 },
  };
}
