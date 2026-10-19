import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@millionsend/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  getAuth: () => ({
    api: {
      getSession: async () => ({
        user: { id: "ada", email: "ada@example.com" },
        session: { id: "s-ada" },
      }),
    },
  }),
}));
// The real English catalogs, so the test reads what the person consenting reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    auth: (await import("../messages/en/auth.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "auth" }),
  };
});
vi.mock("@/lib/trpc", () => {
  const at = (): unknown =>
    new Proxy(() => {}, { get: (_, key: string) => (key.endsWith("Options") ? () => ({}) : at()) });
  return { useTRPC: () => at() };
});
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutateAsync: async () => {} }) }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

const { default: ConsentPage } = await import("@/app/oauth/consent/page");

let close: () => Promise<void>;

beforeEach(async () => {
  ({ db: h.db, close } = await createTestDb());
  await h.db.insert(schema.user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
  const teamId = await createTeam(h.db);
  await h.db.insert(schema.teamMembers).values({ teamId, userId: "ada", role: "owner" });
  // As dynamic client registration stores it: self-registered, never skipping consent.
  await h.db.insert(schema.oauthClient).values({
    id: "c1",
    clientId: "client-1",
    name: "Claude Code",
    redirectUris: ["http://localhost:1234/callback"],
    skipConsent: false,
    createdAt: new Date("2026-10-01T10:00:00Z"),
  });
});

afterEach(async () => {
  await close();
});

async function renderConsent(): Promise<string> {
  const page = await ConsentPage({
    searchParams: Promise.resolve({
      client_id: "client-1",
      scope: "offline_access emails:send",
      sig: "x",
    }),
  });
  return renderToStaticMarkup(page);
}

describe("the OAuth consent page", () => {
  it("names the app, where it sends you back and the client id, with no vendor warning", async () => {
    const html = await renderConsent();
    expect(html).toContain("Authorize Claude Code");
    expect(html).toContain("Sends you back to http://localhost:1234");
    expect(html).toContain("client-1");
    expect(html).not.toContain("Unverified");
    expect(html).not.toContain("reviewed");
    expect(html).not.toContain('role="note"');
  });

  it("shows a custom-scheme callback whole, its invisible and bidi characters escaped", async () => {
    await h.db
      .update(schema.oauthClient)
      .set({
        redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback", "com.example.app:/cb\u202Eexe"],
      })
      .where(eq(schema.oauthClient.clientId, "client-1"));
    const html = await renderConsent();
    expect(html).toContain(
      "Sends you back to cursor://anysphere.cursor-mcp/oauth/callback, com.example.app:/cb%E2%80%AEexe",
    );
    expect(html).not.toContain("\u202E");
  });

  it("offers how long to stay connected, until disconnected by default", async () => {
    const html = await renderConsent();
    expect(html).toContain('<label for="consent-lifetime">Stay connected</label>');
    const trigger = html.match(/<button[^>]*id="consent-lifetime"[^>]*>(.*?)<\/button>/)?.[1];
    expect(trigger).toContain("Until I disconnect it");
    // offline_access is always granted, so the one box is for emails:send.
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain("Send emails");
  });
});
