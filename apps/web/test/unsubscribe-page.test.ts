import { deriveUnsubscribeKey, makeUnsubscribeToken } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  await close();
});

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
  it("carries the contact's team's brand/message/redirect", async () => {
    const teamId = await createTeam(db, "acme");
    await db
      .update(schema.teams)
      .set({
        unsubscribeBrandName: "Acme",
        unsubscribeMessage: "Sorry to see you go.",
        unsubscribeRedirectUrl: "https://acme.com/bye",
      })
      .where(eq(schema.teams.id, teamId));
    const contactId = await seedContact(teamId);
    const token = makeUnsubscribeToken({ contactId, secretKey });

    const target = await targetForToken(db, token);
    expect(target?.customization).toEqual({
      brandName: "Acme",
      message: "Sorry to see you go.",
      redirectUrl: "https://acme.com/bye",
    });
  });

  it("returns null customization fields for a team that never customized", async () => {
    const teamId = await createTeam(db, "plain");
    const contactId = await seedContact(teamId);
    const token = makeUnsubscribeToken({ contactId, secretKey });

    const target = await targetForToken(db, token);
    expect(target?.customization).toEqual({
      brandName: null,
      message: null,
      redirectUrl: null,
    });
  });
});
