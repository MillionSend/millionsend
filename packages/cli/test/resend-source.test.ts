import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthError, createHttp } from "../src/http.js";
import { createLogger } from "../src/log.js";
import { USER_AGENT } from "../src/meta.js";
import { RESOURCES, type Snapshot } from "../src/model.js";
import { providers } from "../src/providers/index.js";
import {
  createResendSource,
  estimateSourceRequests,
  resendBaseUrl,
  type SourceProgress,
} from "../src/providers/resend.js";
import { type FakeContact, type FakeResend, startFakeResend } from "./helpers/fake-resend.js";

const ALL = new Set(RESOURCES);
let fake: FakeResend;
let lines: string[];

const logger = () =>
  createLogger({
    level: "debug",
    stream: {
      write: (chunk: string) => {
        lines.push(String(chunk).trimEnd());
        return true;
      },
    } as never,
  });

function source(token = fake.token, extra = {}) {
  const http = createHttp({
    baseUrl: fake.url,
    token,
    userAgent: USER_AGENT,
    rps: 1000,
    name: "Resend",
    log: logger(),
    readOnly: true,
    ...extra,
  });
  return { http, src: createResendSource(http, logger()) };
}

beforeAll(async () => {
  fake = await startFakeResend();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  lines = [];
});

describe("createResendSource", () => {
  it("probe returns ok with the first domain as a hint", async () => {
    const { src } = source();
    await expect(src.probe()).resolves.toEqual({ ok: true, teamHint: "example.com" });
    expect(fake.requests).toEqual([expect.objectContaining({ path: "/domains" })]);
    expect(fake.requests[0]?.query.get("limit")).toBe("1");
  });

  it("401 is an AuthError, not retried", async () => {
    const { src } = source("re_wrong");
    await expect(src.probe()).rejects.toThrow(AuthError);
    expect(fake.requests).toHaveLength(1);
  });

  it("readShallow maps every resource, GET only, with UA and Bearer on each request", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({ include: ALL });

    expect(snapshot.provider).toBe("resend");
    expect(snapshot.enriched).toBe(false);
    expect(snapshot.metrics).toEqual({ emailsLast30Days: null });

    expect(snapshot.domains.map((d) => [d.name, d.customReturnPath, d.trackingSubdomain])).toEqual([
      ["example.com", null, "track"],
      ["news.example.com", "mail", null],
    ]);
    expect(snapshot.domains[0]).toMatchObject({
      region: "us-east-1",
      openTracking: true,
      clickTracking: true,
      status: "verified",
    });
    expect(snapshot.domains[0]?.records).toHaveLength(4);
    expect(snapshot.domains[0]?.records[1]).toEqual({
      record: "SPF",
      name: "send",
      type: "MX",
      value: "feedback-smtp.us-east-1.amazonses.com",
      ttl: "Auto",
      priority: 10,
      status: "verified",
    });

    expect(snapshot.apiKeys.map((k) => k.name)).toEqual(["Production", "Staging"]);
    expect(snapshot.properties).toEqual([
      { key: "plan", type: "string", fallbackValue: "free" },
      { key: "seats", type: "number", fallbackValue: 1 },
    ]);
    expect(snapshot.topics).toEqual([
      {
        id: "b6d24b8e-af0b-4c3c-be0c-359bbd97381e",
        name: "Product updates",
        description: "New features and changes",
        defaultSubscription: "opt_in",
        visibility: "public",
      },
      {
        id: "c7e35c9f-b01c-4d4d-9f1d-46acce08492f",
        name: "Newsletter",
        description: null,
        defaultSubscription: "opt_out",
        visibility: "private",
      },
    ]);
    expect(snapshot.segments).toEqual([
      {
        id: "78261eea-8f8b-4381-83c6-79fa7120f1cf",
        name: "Active Users",
        filter: {
          operator: "and",
          conditions: [{ field: "plan", op: "eq", value: "pro" }],
        },
        memberEmails: ["steve.wozniak@gmail.com", "ada@example.org"],
      },
    ]);
    expect(snapshot.contacts).toEqual([
      {
        id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
        email: "steve.wozniak@gmail.com",
        firstName: "Steve",
        lastName: "Wozniak",
        unsubscribed: false,
        createdAt: "2023-10-06 23:47:56.678+00",
      },
      expect.objectContaining({ email: "ada@example.org", lastName: null, unsubscribed: true }),
      expect.objectContaining({ email: "grace@example.net", firstName: null }),
    ]);
    expect(snapshot.contacts[0]).not.toHaveProperty("properties");

    expect(snapshot.broadcasts.map((b) => [b.name, b.status, b.html])).toEqual([
      ["November announcements", "draft", "<p>Hello {{{FIRST_NAME|there}}}!</p>"],
      ["Launch day", "sent", null],
    ]);
    expect(snapshot.broadcasts[0]).toMatchObject({
      from: "Acme <onboarding@resend.dev>",
      subject: "Hello World",
      replyTo: [],
      previewText: "Here are our announcements",
      segmentId: "78261eea-8f8b-4381-83c6-79fa7120f1cf",
      topicId: "b6d24b8e-af0b-4c3c-be0c-359bbd97381e",
      scheduledAt: null,
    });

    expect(snapshot.templates).toEqual([
      {
        id: "34a080c9-b17d-4187-ad80-5af20266e535",
        name: "Welcome",
        alias: "welcome",
        from: "Acme <hello@example.com>",
        subject: "Welcome, {{{first_name}}}",
        replyTo: null,
        html: "<h1>Welcome, {{{first_name}}}</h1>",
        text: "Welcome, {{{first_name}}}",
        variables: [
          { key: "first_name", type: "string", fallbackValue: "there" },
          { key: "credits", type: "number", fallbackValue: 10 },
          { key: "flags", type: "object", fallbackValue: '{"beta":true}' },
        ],
      },
    ]);
    expect(snapshot.webhooks).toEqual([
      {
        id: "479e3145-dd38-476b-932c-529ceb705947",
        endpoint: "https://webhook.example.com/handler",
        events: ["email.sent", "email.delivered", "contact.created"],
        status: "enabled",
        signingSecret: "whsec_dGhpcyBpcyBhIGZha2Ugc2VjcmV0MTIz",
      },
    ]);
    expect(snapshot.suppressions).toEqual([
      { email: "bounced@example.org", origin: "bounce", createdAt: "2023-10-06 23:47:56.678+00" },
      {
        email: "complained@example.org",
        origin: "complaint",
        createdAt: "2024-02-14 08:00:00.000+00",
      },
      { email: "blocked@example.org", origin: "manual", createdAt: "2025-07-01 00:00:00.000+00" },
    ]);

    for (const request of fake.requests) {
      expect(request.method).toBe("GET");
      expect(request.userAgent).toMatch(/^millionsend-cli\/\S+ \(\+https:\/\/github\.com\//);
      expect(request.authorization).toBe(`Bearer ${fake.token}`);
    }
    const paths = fake.requests.map((r) => r.path);
    expect(paths).not.toContain("/audiences");
    // Sent broadcast bodies stay unfetched by default.
    expect(paths).not.toContain("/broadcasts/3c9a8b7d-6e5f-4d4c-8b3a-2f1e0d9c8b7a");
    expect(paths).toContain("/webhooks/479e3145-dd38-476b-932c-529ceb705947");
    expect(
      fake.requests.every(
        (r) =>
          r.path === "/emails/metrics" ||
          r.query.get("limit") === "100" ||
          r.path.split("/").length > 2,
      ),
    ).toBe(true);
    expect(src.requests).toBe(fake.requests.length);
    expect(fake.writes).toBe(0);
  });

  it("includeSent fetches sent broadcast bodies; include limits what is read", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({
      include: new Set(["broadcasts"]),
      includeSent: true,
    });
    expect(snapshot.broadcasts[1]).toMatchObject({
      status: "sent",
      html: "<p>We launched today.</p>",
      replyTo: ["support@example.com"],
    });
    expect(snapshot.domains).toEqual([]);
    expect(snapshot.contacts).toEqual([]);
    expect(new Set(fake.requests.map((r) => r.path.split("/")[1]))).toEqual(
      new Set(["broadcasts"]),
    );
  });

  it("walks pages with limit=100 and after cursors, reporting progress", async () => {
    const many: FakeContact[] = Array.from({ length: 250 }, (_, i) => ({
      id: `c-${String(i).padStart(4, "0")}`,
      email: `user${i}@example.com`,
      first_name: null,
      last_name: null,
      created_at: "2025-01-01 00:00:00.000+00",
      unsubscribed: i % 7 === 0,
    }));
    const original = fake.data.contacts;
    fake.data.contacts = many;
    try {
      const events: SourceProgress[] = [];
      const { src } = source();
      const snapshot = await src.readShallow({
        include: new Set(["contacts"]),
        onProgress: (e) => events.push(e),
      });
      expect(snapshot.contacts).toHaveLength(250);
      expect(snapshot.contacts.filter((c) => c.unsubscribed)).toHaveLength(36);
      expect(fake.requests.map((r) => [r.query.get("limit"), r.query.get("after")])).toEqual([
        ["100", null],
        ["100", "c-0099"],
        ["100", "c-0199"],
      ]);
      expect(events).toEqual([
        { label: "Contacts", n: 100, done: false },
        { label: "Contacts", n: 200, done: false },
        { label: "Contacts", n: 250, total: 250, done: true },
      ]);
    } finally {
      fake.data.contacts = original;
    }
  });

  it("a 429 with retry-after is retried and logged", async () => {
    fake.injectOnce("/topics", {
      status: 429,
      headers: { "retry-after": "0" },
      body: { name: "rate_limit_exceeded", message: "slow down" },
    });
    const { src } = source();
    const snapshot = await src.readShallow({ include: new Set(["topics"]) });
    expect(snapshot.topics).toHaveLength(2);
    expect(fake.requests.filter((r) => r.path === "/topics")).toHaveLength(2);
    expect(lines.some((l) => l.startsWith("warning: retry 2/8 in 0s — Resend 429"))).toBe(true);
  });

  it("enrichContacts merges properties and topics, skips alreadyDone, emits per contact", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({
      include: new Set(["properties", "topics", "contacts"]),
    });
    fake.requests.length = 0;
    const emitted: string[] = [];
    const events: SourceProgress[] = [];
    const done = new Set(["a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d"]);
    const result = await src.enrichContacts(snapshot, {
      alreadyDone: done,
      concurrency: 1,
      onProgress: (e) => events.push(e),
      onContact: async (contact) => {
        emitted.push(contact.email);
      },
    });
    expect(result).toBe(snapshot);
    expect(result.enriched).toBe(true);
    expect(emitted).toEqual(["steve.wozniak@gmail.com", "grace@example.net"]);
    expect(result.contacts[0]).toMatchObject({
      properties: { plan: "pro", seats: 5 },
      topics: [
        { id: "b6d24b8e-af0b-4c3c-be0c-359bbd97381e", subscription: "opt_in" },
        { id: "c7e35c9f-b01c-4d4d-9f1d-46acce08492f", subscription: "opt_out" },
      ],
    });
    expect(result.contacts[1]).not.toHaveProperty("properties");
    expect(result.contacts[2]).toMatchObject({ properties: {}, topics: [] });
    expect(fake.requests.map((r) => r.path)).toEqual([
      "/contacts/e169aa45-1ecf-4183-9955-b1499d5701d3",
      "/contacts/e169aa45-1ecf-4183-9955-b1499d5701d3/topics",
      "/contacts/f0e1d2c3-b4a5-4968-8776-655443322110",
      "/contacts/f0e1d2c3-b4a5-4968-8776-655443322110/topics",
    ]);
    // The contact already done counts as completed from the start.
    expect(events).toEqual([
      { label: "Enrichment", n: 2, total: 3, done: false },
      { label: "Enrichment", n: 3, total: 3, done: false },
      { label: "Enrichment", n: 3, total: 3, done: true },
    ]);
    expect(fake.writes).toBe(0);
  });

  it("enrichContacts reads a few contacts ahead and still hands them over one at a time", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({
      include: new Set(["properties", "topics", "contacts"]),
    });
    fake.requests.length = 0;
    const emitted: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    await src.enrichContacts(snapshot, {
      onContact: async (contact) => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        emitted.push(contact.email);
        inFlight -= 1;
      },
    });
    expect(overlapped).toBe(false);
    expect(emitted.sort()).toEqual(snapshot.contacts.map((c) => c.email).sort());
    expect(fake.requests.filter((r) => r.path.endsWith("/topics"))).toHaveLength(3);
    // Every property arrives unwrapped from Resend's {value, type} shape; a null value is no key.
    expect(
      snapshot.contacts.find((c) => c.email === "steve.wozniak@gmail.com")?.properties,
    ).toEqual({
      plan: "pro",
      seats: 5,
    });
    const nullSeats = snapshot.contacts.find(
      (c) => c.id === "a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d",
    );
    expect(nullSeats?.properties).not.toHaveProperty("seats");
  });

  it("enrichContacts with one facet leaves the other untouched", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({
      include: new Set(["properties", "topics", "contacts"]),
    });
    fake.requests.length = 0;
    await src.enrichContacts(snapshot, { facets: ["topics"], onContact: () => {} });
    expect(fake.requests.every((r) => r.path.endsWith("/topics"))).toBe(true);
    expect(snapshot.contacts[0]).not.toHaveProperty("properties");
    expect(snapshot.contacts[0]?.topics).toBeDefined();
  });

  it("listAll stops with a PaginationError when the server ignores the cursor", async () => {
    const { src } = source();
    const twoRows = {
      status: 200,
      body: {
        object: "list",
        data: [
          { id: "e169aa45-1ecf-4183-9955-b1499d5701d3", email: "steve.wozniak@gmail.com" },
          { id: "f0e1d2c3-b4a5-4968-8776-655443322110", email: "grace@example.net" },
        ],
        has_more: true,
      },
    };
    fake.injectOnce("/contacts", twoRows);
    fake.injectOnce("/contacts", twoRows);
    await expect(src.readShallow({ include: new Set(["contacts"]) })).rejects.toThrow(
      /ignored `after`/,
    );
  });

  it("readShallow lists contacts, properties and topics for an enrichment-only include", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({ include: new Set(["enrichment"]) });
    expect(snapshot.contacts.length).toBeGreaterThan(0);
    expect(snapshot.properties.length).toBeGreaterThan(0);
    expect(snapshot.topics.length).toBeGreaterThan(0);
    expect(snapshot.domains).toEqual([]);
  });

  it("enrichContacts makes no request when the account has no properties or topics", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({ include: new Set(["contacts"]) });
    fake.requests.length = 0;
    let calls = 0;
    await src.enrichContacts(snapshot, {
      onContact: () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
    expect(snapshot.enriched).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it("readMetrics totals the last 30 days of sends and never throws", async () => {
    const { src } = source();
    await expect(src.readMetrics()).resolves.toEqual({ emailsLast30Days: 41208 });
    const [request] = fake.requests;
    expect(request?.path).toBe("/emails/metrics");
    expect(request?.query.get("metrics")).toBe("sent");
    const start = Date.parse(request?.query.get("start_date") ?? "");
    const end = Date.parse(request?.query.get("end_date") ?? "");
    expect(Math.round((end - start) / 86_400_000)).toBe(30);

    fake.injectOnce("/emails/metrics", { status: 404, body: { name: "not_found" } });
    await expect(src.readMetrics()).resolves.toEqual({ emailsLast30Days: null });
    expect(lines.some((line) => line.includes("metrics unavailable"))).toBe(true);
  });

  it("never writes: the client refuses non-GET before the network, the fake counts none", async () => {
    const { http } = source();
    await expect(http.post("/contacts", {})).rejects.toThrow("Resend is read-only");
    await expect(http.delete("/contacts/x")).rejects.toThrow("Resend is read-only");
    expect(fake.requests).toEqual([]);
    expect(fake.writes).toBe(0);
  });
});

describe("estimateSourceRequests", () => {
  it("reconstructs shallow pages and counts one GET per contact per facet", async () => {
    const { src } = source();
    const snapshot = await src.readShallow({ include: ALL });
    const estimate = estimateSourceRequests(snapshot);
    expect(estimate).toEqual({ spent: fake.requests.length, enrichment: 6 });
    const bare: Snapshot = { ...snapshot, properties: [], topics: [] };
    expect(estimateSourceRequests(bare).enrichment).toBe(0);
  });
});

describe("providers registry", () => {
  it("exposes resend with a CLI-only base URL override", () => {
    expect(providers.resend.label).toBe("Resend");
    expect(providers.resend.baseUrl({})).toBe("https://api.resend.com");
    expect(resendBaseUrl({ MILLIONSEND_CLI_RESEND_URL: "http://127.0.0.1:9" })).toBe(
      "http://127.0.0.1:9",
    );
    // The app-side cutover variable must never redirect the Resend key.
    expect(resendBaseUrl({ RESEND_BASE_URL: "http://127.0.0.1:9" })).toBe("https://api.resend.com");
    expect(providers.resend.create).toBe(createResendSource);
  });
});
