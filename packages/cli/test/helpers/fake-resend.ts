import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A wire row as Resend returns it from the detail endpoint; list views strip fields. */
export type Row = { id: string } & Record<string, unknown>;

export interface FakeContact extends Row {
  email: string;
  properties?: Record<string, unknown>;
  topics?: { id: string; name: string; description: string | null; subscription: string }[];
}

export interface FakeSegment extends Row {
  name: string;
  filter?: unknown;
  member_ids?: string[];
}

export interface FakeResendData {
  domains: Row[];
  api_keys: Row[];
  contact_properties: Row[];
  topics: Row[];
  segments: FakeSegment[];
  contacts: FakeContact[];
  broadcasts: Row[];
  templates: Row[];
  webhooks: Row[];
  suppressions: Row[];
  /** `totals` of GET /emails/metrics; null makes the endpoint answer 404. */
  metrics: Record<string, number> | null;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  userAgent: string | null;
  authorization: string | null;
}

export interface InjectedReply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface FakeResend {
  url: string;
  token: string;
  data: FakeResendData;
  /** Every request seen, in order, including refused ones. */
  requests: FakeRequest[];
  /** Non-GET requests seen; the fake answers them with 500. */
  writes: number;
  /** Next request whose path starts with `pathPrefix` gets this reply instead. */
  injectOnce(pathPrefix: string, reply: InjectedReply): void;
  close(): Promise<void>;
}

const FIXTURES = new URL("../fixtures/resend/", import.meta.url);

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as T;

/** The fixture account: two domains, three contacts, one segment, and so on. */
export function loadFixtures(): FakeResendData {
  return {
    domains: fixture("domains"),
    api_keys: fixture("api-keys"),
    contact_properties: fixture("contact-properties"),
    topics: fixture("topics"),
    segments: fixture("segments"),
    contacts: fixture("contacts"),
    broadcasts: fixture("broadcasts"),
    templates: fixture("templates"),
    webhooks: fixture("webhooks"),
    suppressions: fixture("suppressions"),
    metrics: fixture("metrics"),
  };
}

const omit = (row: Row, ...keys: string[]): Row => {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
};

/** Cursor pagination as Resend does it: `after` is the id of the last item seen. */
function page(rows: Row[], query: URLSearchParams): unknown {
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? 100)));
  const after = query.get("after");
  const start = after === null ? 0 : rows.findIndex((row) => row.id === after) + 1;
  return {
    object: "list",
    has_more: start + limit < rows.length,
    data: rows.slice(start, start + limit),
  };
}

const LIST_VIEW: Record<string, (row: Row) => Row> = {
  domains: (row) => omit(row, "records", "tracking_subdomain"),
  segments: (row) => omit(row, "filter", "member_ids"),
  contacts: (row) => omit(row, "properties", "topics"),
  broadcasts: (row) => omit(row, "from", "subject", "reply_to", "preview_text", "html", "text"),
  templates: (row) =>
    omit(row, "current_version_id", "from", "subject", "reply_to", "html", "text", "variables"),
  webhooks: (row) => omit(row, "signing_secret"),
};

const DETAIL_OBJECT: Record<string, string> = {
  domains: "domain",
  segments: "segment",
  contacts: "contact",
  broadcasts: "broadcast",
  templates: "template",
  webhooks: "webhook",
  topics: "topic",
  "contact-properties": "contact_property",
};

const COLLECTION: Record<string, keyof FakeResendData> = {
  domains: "domains",
  "api-keys": "api_keys",
  "contact-properties": "contact_properties",
  topics: "topics",
  segments: "segments",
  contacts: "contacts",
  broadcasts: "broadcasts",
  templates: "templates",
  webhooks: "webhooks",
  suppressions: "suppressions",
};

/** Boots the fake on a free port. GET only, every documented list paginates, writes answer 500. */
export async function startFakeResend(
  data: FakeResendData = loadFixtures(),
  token = "re_test_1234567890abcdef",
): Promise<FakeResend> {
  const requests: FakeRequest[] = [];
  const injections: { prefix: string; reply: InjectedReply }[] = [];
  const fake: FakeResend = {
    url: "",
    token,
    data,
    requests,
    writes: 0,
    injectOnce: (prefix, reply) => injections.push({ prefix, reply }),
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers = {}): void => {
    // Resend answers every request with its team limit headers.
    res.writeHead(status, {
      "content-type": "application/json",
      "ratelimit-limit": "10",
      "ratelimit-remaining": "9",
      "ratelimit-reset": "1",
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  const route = (method: string, url: URL): { status: number; body: unknown } => {
    if (method !== "GET") {
      fake.writes += 1;
      return {
        status: 500,
        body: { name: "internal_server_error", message: "fake Resend is read-only" },
      };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const [head, id, sub] = parts;
    if (head === "emails" && id === "metrics" && sub === undefined) {
      if (data.metrics === null)
        return { status: 404, body: { name: "not_found", message: "no metrics" } };
      const wanted = (url.searchParams.get("metrics") ?? "").split(",").filter(Boolean);
      const totals = Object.fromEntries(
        Object.entries(data.metrics).filter(([key]) => wanted.length === 0 || wanted.includes(key)),
      );
      return {
        status: 200,
        body: {
          object: "metrics",
          start_date: url.searchParams.get("start_date"),
          end_date: url.searchParams.get("end_date"),
          metrics: Object.keys(totals),
          dimensions: [],
          granularity: "daily",
          totals,
        },
      };
    }
    const collection = head === undefined ? undefined : COLLECTION[head];
    if (head === undefined || collection === undefined || collection === "metrics") {
      return { status: 404, body: { name: "not_found", message: `no route for ${url.pathname}` } };
    }
    const rows = data[collection] as Row[];
    if (id === undefined) {
      // Like Resend, GET /contacts ignores segment_id: the whole list comes back.
      const view = LIST_VIEW[head] ?? ((row: Row) => row);
      return { status: 200, body: page(rows.map(view), url.searchParams) };
    }
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined)
      return { status: 404, body: { name: "not_found", message: `${head} ${id} not found` } };
    if (head === "segments" && sub === "contacts") {
      const members = new Set((row as { member_ids?: string[] }).member_ids ?? []);
      const view = LIST_VIEW.contacts ?? ((r: Row) => r);
      const listed = (data.contacts as Row[]).filter((c) => members.has(c.id)).map(view);
      return { status: 200, body: page(listed, url.searchParams) };
    }
    if (head === "contacts" && sub === "topics") {
      const topics = ((row as FakeContact).topics ?? []) as Row[];
      return { status: 200, body: page(topics, url.searchParams) };
    }
    if (sub !== undefined) {
      return { status: 404, body: { name: "not_found", message: `no route for ${url.pathname}` } };
    }
    const detail =
      head === "contacts"
        ? wireContactDetail(omit(row, "topics"))
        : head === "segments"
          ? omit(row, "member_ids")
          : row;
    return { status: 200, body: { object: DETAIL_OBJECT[head] ?? head, ...detail } };
  };

  /** GET /contacts/{id} wraps each property as {value, type}; the fixtures hold the flat seed. */
  const wireContactDetail = (row: Row): Row => {
    const { properties, ...rest } = row as Row & { properties?: Record<string, unknown> };
    const wrapped = Object.fromEntries(
      Object.entries(properties ?? {}).flatMap(([key, value]) =>
        value === null || value === undefined
          ? []
          : [[key, { value, type: typeof value === "number" ? "number" : "string" }]],
      ),
    );
    return { ...rest, properties: wrapped };
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://fake.resend");
    const userAgent = req.headers["user-agent"] ?? null;
    const authorization = req.headers.authorization ?? null;
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      userAgent,
      authorization,
    });
    if (userAgent === null) {
      return send(res, 400, { name: "validation_error", message: "User-Agent header is required" });
    }
    if (authorization !== `Bearer ${token}`) {
      return send(res, 401, { name: "invalid_api_key", message: "API key is invalid" });
    }
    const injection = injections.find((i) => url.pathname.startsWith(i.prefix));
    if (injection !== undefined) {
      injections.splice(injections.indexOf(injection), 1);
      const { reply } = injection;
      return send(res, reply.status, reply.body ?? {}, reply.headers);
    }
    const { status, body } = route(method, url);
    send(res, status, body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
