import { deriveUnsubscribeKey, hashRecipient, makeUnsubscribeToken } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A known 32-byte master key so lookup derives the same key we sign with.
const KEY_B64 = "dOdpMPArQsV3KWv5I+kizDihKLus3uMLev4DODaFnOQ=";
process.env.MASTER_ENCRYPTION_KEY = KEY_B64;
const secretKey = deriveUnsubscribeKey(Buffer.from(KEY_B64, "base64"));

// getDb() inside the route handler must hit the per-test PGlite db.
const h = vi.hoisted(() => ({ db: undefined as unknown as Db }));
vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
});

const { postUnsubscribeLocation, targetForToken } = await import("@/app/unsubscribe/lookup");
const { GET, POST } = await import("@/app/unsubscribe/[token]/route");

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

/** Credentials + both storage vars set ⇒ uploadsEnabled() is true, so stored logo URLs count as servable. */
function stubStorage(): void {
  vi.stubEnv("S3_ENDPOINT", "https://acc.r2.cloudflarestorage.com");
  vi.stubEnv("S3_ACCESS_KEY_ID", "key");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "secret");
  vi.stubEnv("S3_STORAGE_BUCKET", "ms-uploads");
  vi.stubEnv("S3_STORAGE_PUBLIC_URL", "https://cdn.example.com");
}

async function seedContact(teamId: string): Promise<string> {
  const [contact] = await db
    .insert(schema.contacts)
    .values({ teamId, email: "ada@x.com" })
    .returning({ id: schema.contacts.id });
  return contact?.id ?? "";
}

describe("postUnsubscribeLocation", () => {
  it("redirects to the team URL when set", () => {
    expect(postUnsubscribeLocation("tok", "https://acme.com/bye")).toBe("https://acme.com/bye");
  });

  it("falls back to the in-place done state on APP_BASE_URL when no redirect is configured", () => {
    vi.stubEnv("APP_BASE_URL", "https://app.test");
    expect(postUnsubscribeLocation("a/b", null)).toBe(
      "https://app.test/unsubscribe/confirm/a%2Fb?done=1",
    );
  });
});

describe("/unsubscribe/[token] route", () => {
  // The proxy in front of the app rewrites Host to its upstream; every
  // redirect must still land on the public origin.
  const APP = "https://app.example.com";
  const call = (method: "GET" | "POST", token: string, body = "") =>
    (method === "GET" ? GET : POST)(
      new Request(`https://localhost:3000/unsubscribe/${encodeURIComponent(token)}`, {
        method,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        ...(method === "POST" ? { body } : {}),
      }),
      { params: Promise.resolve({ token }) },
    );

  it("redirects on APP_BASE_URL regardless of the request host", async () => {
    vi.stubEnv("APP_BASE_URL", APP);
    const teamId = await createTeam(db, "acme");
    const token = makeUnsubscribeToken({ contactId: await seedContact(teamId), secretKey });

    const get = await call("GET", token);
    expect(get.status).toBe(302);
    expect(new URL(get.headers.get("location") ?? "").origin).toBe(APP);

    const post = await call("POST", token);
    expect(post.status).toBe(303);
    expect(get.headers.get("location")).not.toContain("localhost");
    expect(new URL(post.headers.get("location") ?? "").origin).toBe(APP);
  });

  it("retains a global unsubscribe as a suppression, once", async () => {
    vi.stubEnv("APP_BASE_URL", APP);
    const teamId = await createTeam(db, "acme");
    const contactId = await seedContact(teamId);
    const token = makeUnsubscribeToken({ contactId, secretKey });

    expect((await call("POST", token, "List-Unsubscribe=One-Click")).status).toBe(200);
    // A scanner re-hit must not trip the (team, hash) unique index.
    expect((await call("POST", token, "List-Unsubscribe=One-Click")).status).toBe(200);

    const rows = await db
      .select()
      .from(schema.suppressions)
      .where(eq(schema.suppressions.teamId, teamId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "ada@x.com",
      emailHash: hashRecipient("ada@x.com"),
      reason: "one_click_unsubscribe",
    });
    const [contact] = await db
      .select({ unsubscribed: schema.contacts.unsubscribed })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, contactId));
    expect(contact?.unsubscribed).toBe(true);
  });
});

describe("targetForToken customization", () => {
  it("carries the team's brand, texts, colors, and redirect", async () => {
    const teamId = await createTeam(db, "acme");
    await db
      .update(schema.teams)
      .set({
        unsubscribeBrandName: "Acme",
        unsubscribeMessage: "Sorry to see you go.",
        unsubscribeSuccessMessage: "All set.",
        unsubscribeRedirectUrl: "https://acme.com/bye",
        unsubscribeBackgroundColor: "#000000",
        unsubscribeTextColor: "#ffffff",
        unsubscribeAccentColor: "#46a3f9",
      })
      .where(eq(schema.teams.id, teamId));
    const contactId = await seedContact(teamId);
    const token = makeUnsubscribeToken({ contactId, secretKey });

    const target = await targetForToken(db, token);
    expect(target?.customization).toEqual({
      brandName: "Acme",
      message: "Sorry to see you go.",
      successMessage: "All set.",
      redirectUrl: "https://acme.com/bye",
      logoUrl: null,
      backgroundColor: "#000000",
      textColor: "#ffffff",
      accentColor: "#46a3f9",
    });
  });

  it("defaults a never-customized team to its own name as the brand", async () => {
    const teamId = await createTeam(db, "plain");
    const contactId = await seedContact(teamId);
    const token = makeUnsubscribeToken({ contactId, secretKey });

    const target = await targetForToken(db, token);
    expect(target?.customization).toEqual({
      brandName: "plain",
      message: null,
      successMessage: null,
      redirectUrl: null,
      // hideBranding defaults on, but with no stored logo there is none to show.
      logoUrl: null,
      backgroundColor: null,
      textColor: null,
      accentColor: null,
    });
  });

  it("exposes the logo only when the team opted in AND storage can serve it", async () => {
    const teamId = await createTeam(db, "acme");
    await db
      .update(schema.teams)
      .set({
        logoUrl: "https://cdn.example.com/team-logos/x.png?v=1",
        unsubscribeHideBranding: true,
      })
      .where(eq(schema.teams.id, teamId));
    const contactId = await seedContact(teamId);
    const token = makeUnsubscribeToken({ contactId, secretKey });

    // Storage off ⇒ the stored URL may be dead, so it never reaches the page.
    expect((await targetForToken(db, token))?.customization.logoUrl).toBeNull();

    stubStorage();
    expect((await targetForToken(db, token))?.customization.logoUrl).toBe(
      "https://cdn.example.com/team-logos/x.png?v=1",
    );

    // Opt-out wins even with storage on and a logo stored.
    await db
      .update(schema.teams)
      .set({ unsubscribeHideBranding: false })
      .where(eq(schema.teams.id, teamId));
    expect((await targetForToken(db, token))?.customization.logoUrl).toBeNull();
  });
});
