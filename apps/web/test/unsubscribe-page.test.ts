import { deriveUnsubscribeKey, makeUnsubscribeToken } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A known 32-byte master key so lookup derives the same key we sign with.
const KEY_B64 = "dOdpMPArQsV3KWv5I+kizDihKLus3uMLev4DODaFnOQ=";
process.env.MASTER_ENCRYPTION_KEY = KEY_B64;
const secretKey = deriveUnsubscribeKey(Buffer.from(KEY_B64, "base64"));

const { postUnsubscribeLocation, targetForToken } = await import("@/app/unsubscribe/lookup");

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
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
    expect(
      postUnsubscribeLocation("https://app.test/unsubscribe/tok", "tok", "https://acme.com/bye"),
    ).toBe("https://acme.com/bye");
  });

  it("falls back to the in-place done state when no redirect is configured", () => {
    expect(postUnsubscribeLocation("https://app.test/unsubscribe/a%2Fb", "a/b", null)).toBe(
      "https://app.test/unsubscribe/confirm/a%2Fb?done=1",
    );
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
