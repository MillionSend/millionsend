import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, MCP_SCOPES, mcpResourceUrl } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

/**
 * MCP resource server against createApi in process: bearer JWTs are minted
 * with a test Ed25519 key whose public JWK is served over a real local HTTP
 * server, so token verification exercises the same remote-JWKS path
 * production uses against the dashboard's /api/auth/jwks.
 */

let db: Db;
let closeDb: () => Promise<void>;
let jwksServer: ServerType;
let appBaseUrl: string;
let resource: string;
let app: ReturnType<typeof createApi>;
let teamId: string;
let topicId: string;
let segmentId: string;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const userId = "mcp-user-1";
const enqueued: string[] = [];

const ALL_SCOPES = MCP_SCOPES.join(" ");

const JSONRPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

async function mintToken(
  overrides: Partial<{ scope: string; aud: string; sub: string; team_id: string }> = {},
): Promise<string> {
  return new SignJWT({
    scope: overrides.scope ?? ALL_SCOPES,
    client_id: "client-abc",
    team_id: overrides.team_id ?? teamId,
    team_role: "admin",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer(appBaseUrl)
    .setAudience(overrides.aud ?? resource)
    .setSubject(overrides.sub ?? userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(privateKey);
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${resource}`), {
      fetch: async (url, init) => app.request(url, init),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function resultJson(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content.find((c) => c.type === "text");
  if (!text) throw new Error("tool returned no text content");
  return JSON.parse(text.text) as Record<string, unknown>;
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "mcp");
  await db.insert(schema.user).values({ id: userId, name: "MCP User", email: "mcp@acme.dev" });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "admin" });
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Newsletter", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  topicId = topic?.id ?? "";
  const [segment] = await db
    .insert(schema.segments)
    .values({ teamId, name: "VIPs" })
    .returning({ id: schema.segments.id });
  segmentId = segment?.id ?? "";

  const keys = await generateKeyPair("EdDSA");
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "EdDSA" };
  const jwks = new Hono().get("/api/auth/jwks", (c) => c.json({ keys: [jwk] }));
  await new Promise<void>((resolve) => {
    jwksServer = serve({ fetch: jwks.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  const address = jwksServer.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  appBaseUrl = `http://127.0.0.1:${address.port}`;
  resource = mcpResourceUrl(appBaseUrl);

  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    appBaseUrl,
    enqueueEmailSend: async (id) => {
      enqueued.push(id);
    },
    ses: {
      clientForRegion: () => {
        throw new Error("SES is not exercised by these tests");
      },
      defaultRegion: "us-east-1",
    },
  });
});

afterAll(async () => {
  jwksServer.close();
  await closeDb();
});

describe("auth middleware", () => {
  it("401s without a token, advertising the resource metadata URL", async () => {
    const res = await app.request("/mcp", { method: "POST", headers: JSONRPC_HEADERS, body: ping });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      `resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });

  it("serves the RFC 9728 protected resource metadata", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource,
        authorization_servers: [appBaseUrl],
        scopes_supported: [...MCP_SCOPES],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("401s a token minted for another resource (aud mismatch)", async () => {
    const token = await mintToken({ aud: "https://elsewhere.example/mcp" });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, authorization: `Bearer ${token}` },
      body: ping,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });

  it("403s a token carrying no MillionSend scope", async () => {
    const token = await mintToken({ scope: "openid profile" });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, authorization: `Bearer ${token}` },
      body: ping,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("401s a valid token whose holder is no longer a team member", async () => {
    const token = await mintToken({ sub: "someone-who-left" });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, authorization: `Bearer ${token}` },
      body: ping,
    });
    expect(res.status).toBe(401);
  });
});

describe("tool listing", () => {
  it("lists read-only tools first and hides tools outside the token's scopes", async () => {
    const full = await connect(await mintToken());
    const names = (await full.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([
      "list_emails",
      "get_email",
      "list_contacts",
      "get_contact",
      "list_segments",
      "list_topics",
      "list_domains",
      "send_email",
      "create_contact",
      "update_contact",
      "add_contact_to_segment",
      "create_broadcast",
      "send_broadcast",
    ]);
    await full.close();

    const readOnly = await connect(await mintToken({ scope: "audience:read" }));
    expect((await readOnly.listTools()).tools.map((t) => t.name)).toEqual([
      "list_contacts",
      "get_contact",
      "list_segments",
      "list_topics",
    ]);
    await readOnly.close();
  });
});

describe("tools", () => {
  it("send_email goes through the real accept pipeline; get_email and list_emails read back", async () => {
    const client = await connect(await mintToken());
    const sent = await client.callTool({
      name: "send_email",
      arguments: {
        from: "Acme <onboarding@acme.dev>",
        to: ["delivered@example.com"],
        subject: "mcp hello",
        html: "<p>oi</p>",
      },
    });
    expect(sent.isError).toBeFalsy();
    const id = resultJson(sent).id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(enqueued).toContain(id);

    // The email row is team-scoped to the token's team, with no API key.
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row?.teamId).toBe(teamId);
    expect(row?.apiKeyId).toBeNull();

    const fetched = await client.callTool({ name: "get_email", arguments: { id } });
    expect(resultJson(fetched)).toMatchObject({ object: "email", subject: "mcp hello" });

    const listed = await client.callTool({ name: "list_emails", arguments: { limit: 10 } });
    const list = resultJson(listed) as { data: Array<{ id: string }>; has_more: boolean };
    expect(list.data.map((e) => e.id)).toContain(id);

    // The in-process REST call is logged like any API request, redacted.
    await vi.waitFor(async () => {
      const logs = await db
        .select()
        .from(schema.apiRequests)
        .where(and(eq(schema.apiRequests.teamId, teamId), eq(schema.apiRequests.path, "/emails")));
      expect(logs.length).toBeGreaterThan(0);
      expect((logs[0]?.requestBody as { html: string } | undefined)?.html).toBe("[redacted]");
    });
    await client.close();
  });

  it("rejects an unverified sender domain through the same rule as the REST API", async () => {
    const client = await connect(await mintToken());
    const sent = await client.callTool({
      name: "send_email",
      arguments: { from: "spoof@other.dev", to: ["x@example.com"], subject: "no", text: "no" },
    });
    expect(sent.isError).toBe(true);
    expect(resultJson(sent)).toMatchObject({ statusCode: 422, name: "validation_error" });
    await client.close();
  });

  it("contact tools: create, get by email, update, segment membership", async () => {
    const client = await connect(await mintToken());
    const created = await client.callTool({
      name: "create_contact",
      arguments: { email: "vip@example.com", first_name: "Vi", topics: [] },
    });
    expect(created.isError).toBeFalsy();
    const contactId = resultJson(created).id as string;

    const updated = await client.callTool({
      name: "update_contact",
      arguments: { id: "vip@example.com", first_name: "Vip" },
    });
    expect(updated.isError).toBeFalsy();

    const fetched = await client.callTool({
      name: "get_contact",
      arguments: { id: contactId },
    });
    expect(resultJson(fetched)).toMatchObject({ email: "vip@example.com", first_name: "Vip" });

    const added = await client.callTool({
      name: "add_contact_to_segment",
      arguments: { contact_id: "vip@example.com", segment_id: segmentId },
    });
    expect(added.isError).toBeFalsy();

    const inSegment = await client.callTool({
      name: "list_contacts",
      arguments: { segment_id: segmentId },
    });
    const seg = resultJson(inSegment) as { data: Array<{ id: string }> };
    expect(seg.data.map((c) => c.id)).toEqual([contactId]);

    const topics = resultJson(await client.callTool({ name: "list_topics", arguments: {} })) as {
      data: Array<{ id: string }>;
    };
    expect(topics.data.map((t) => t.id)).toContain(topicId);

    const segments = resultJson(
      await client.callTool({ name: "list_segments", arguments: {} }),
    ) as { data: Array<{ id: string }> };
    expect(segments.data.map((s) => s.id)).toContain(segmentId);
    await client.close();
  });

  it("broadcast tools: create a draft, then send it", async () => {
    const client = await connect(await mintToken());
    const created = await client.callTool({
      name: "create_broadcast",
      arguments: {
        from: "Acme <news@acme.dev>",
        subject: "March news",
        html: "<p>news {{{UNSUBSCRIBE_URL}}}</p>",
        segment_id: segmentId,
      },
    });
    expect(created.isError).toBeFalsy();
    const broadcastId = resultJson(created).id as string;

    const sent = await client.callTool({
      name: "send_broadcast",
      arguments: { id: broadcastId },
    });
    expect(sent.isError).toBeFalsy();
    const [row] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, broadcastId));
    expect(row?.status).not.toBe("draft");
    await client.close();
  });

  it("list_domains reads the team's domains", async () => {
    const client = await connect(await mintToken({ scope: "domains:read" }));
    const domains = resultJson(await client.callTool({ name: "list_domains", arguments: {} })) as {
      data: Array<{ name: string; status: string }>;
    };
    expect(domains.data.map((d) => d.name)).toContain("acme.dev");
    await client.close();
  });
});

describe("rate limiting", () => {
  it("429s a user who exceeds the per-minute cap on /mcp", async () => {
    const limited = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: false,
      appBaseUrl,
      rateLimitPerMinute: 2,
      enqueueEmailSend: async () => {},
    });
    const token = await mintToken({ sub: "rate-limited-user" });
    await db
      .insert(schema.user)
      .values({ id: "rate-limited-user", name: "RL", email: "rl@acme.dev" });
    await db.insert(schema.teamMembers).values({ teamId, userId: "rate-limited-user" });
    // Fixed one-minute window: the cap must trip within limit+1 consecutive calls.
    let last = 0;
    for (let i = 0; i < 4; i++) {
      const res = await limited.request("/mcp", {
        method: "POST",
        headers: { ...JSONRPC_HEADERS, authorization: `Bearer ${token}` },
        body: ping,
      });
      last = res.status;
      if (res.status === 429) {
        expect(res.headers.get("retry-after")).toBe("60");
        return;
      }
    }
    expect.fail(`rate limit never tripped (last status ${last})`);
  });
});
