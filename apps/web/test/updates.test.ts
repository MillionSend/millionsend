import { randomBytes } from "node:crypto";
import {
  deriveUpdatesKey,
  hashRecipient,
  makeUpdatesToken,
  type SystemMailMessage,
  SystemMailRefused,
  verifyUpdatesToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmUpdatesSubscription, requestUpdatesConfirmation } from "@/server/updates";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sent: SystemMailMessage[];
const mail = { send: async (m: SystemMailMessage) => void sent.push(m) };

beforeEach(async () => {
  vi.stubEnv("MASTER_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.example.com>");
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "owner");
  await db.insert(schema.domains).values({
    teamId,
    name: "mail.example.com",
    region: "us-east-1",
    status: "verified",
  });
  sent = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

describe("updates token", () => {
  const key = deriveUpdatesKey(randomBytes(32));
  it("round-trips, and rejects tampering, another key, and age", () => {
    const token = makeUpdatesToken({
      email: "op@example.com",
      source: "self-host",
      issuedAt: 1_000,
      secretKey: key,
    });
    expect(verifyUpdatesToken(token, key, { maxAgeMs: 10_000, now: 5_000 })).toEqual({
      email: "op@example.com",
      source: "self-host",
    });
    expect(verifyUpdatesToken(token, key, { maxAgeMs: 10_000, now: 20_000 })).toBeNull();
    expect(
      verifyUpdatesToken(token, deriveUpdatesKey(randomBytes(32)), { maxAgeMs: 1e9 }),
    ).toBeNull();
    expect(verifyUpdatesToken(`${token}x`, key, { maxAgeMs: 1e9 })).toBeNull();
    expect(verifyUpdatesToken("nope", key, { maxAgeMs: 1e9 })).toBeNull();
  });
});

describe("product-updates opt-in", () => {
  it("sends a confirmation link and stores nothing until it is opened", async () => {
    expect(
      await requestUpdatesConfirmation(
        db,
        { email: "op@example.com", source: "self-host", locale: "pt-BR" },
        mail,
      ),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "updates.confirm",
      to: "op@example.com",
      subject: "Confirme as novidades do MillionSend",
    });
    expect(await db.select().from(schema.contacts)).toHaveLength(0);

    const url = new URL(sent[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://app.example.com/updates/confirm");
    const token = url.searchParams.get("token") ?? "";
    expect(await confirmUpdatesSubscription(db, token, "pt-BR")).toEqual({
      email: "op@example.com",
    });
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.teamId, teamId));
    expect(contact).toMatchObject({
      email: "op@example.com",
      properties: { source: "self-host", locale: "pt-BR" },
    });
    // Opening the link twice is harmless.
    expect(await confirmUpdatesSubscription(db, token, "en")).toEqual({ email: "op@example.com" });
    expect(await db.select().from(schema.contacts)).toHaveLength(1);
  });

  it("a suppressed address answers like any other: no throw, nothing said", async () => {
    const refusing = {
      send: async () => {
        throw new SystemMailRefused("all_suppressed");
      },
    };
    expect(
      await requestUpdatesConfirmation(
        db,
        { email: "bounced@example.com", source: "updates", locale: "en" },
        refusing,
      ),
    ).toBe(true);
  });

  it("confirming subscribes an unsubscribed contact again and clears its one-click suppression", async () => {
    await db.insert(schema.contacts).values({
      teamId,
      email: "op@example.com",
      unsubscribed: true,
      unsubscribedAt: new Date(),
    });
    await db.insert(schema.suppressions).values({
      teamId,
      email: "op@example.com",
      emailHash: hashRecipient("op@example.com"),
      reason: "one_click_unsubscribe",
    });
    await requestUpdatesConfirmation(
      db,
      { email: "op@example.com", source: "updates", locale: "en" },
      mail,
    );
    const token = new URL(sent[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? "").searchParams.get(
      "token",
    );
    expect(await confirmUpdatesSubscription(db, token ?? "", "en")).toEqual({
      email: "op@example.com",
    });
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.teamId, teamId));
    expect(contact).toMatchObject({ unsubscribed: false, unsubscribedAt: null });
    expect(await db.select().from(schema.suppressions)).toHaveLength(0);
  });

  it("a tampered link enrolls nobody", async () => {
    expect(await confirmUpdatesSubscription(db, "bogus.token", "en")).toBeNull();
    expect(await db.select().from(schema.contacts)).toHaveLength(0);
  });

  it("an instance with no account-mail team sends nothing", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "no-reply@unowned.example.com");
    expect(
      await requestUpdatesConfirmation(
        db,
        { email: "op@example.com", source: "updates", locale: "en" },
        mail,
      ),
    ).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
