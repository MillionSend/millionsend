import { randomBytes } from "node:crypto";
import { decryptEmailBody, EnvKeyring, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOnboardingEmail } from "@/server/onboarding-mail";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

const MASTER_KEY = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = MASTER_KEY;

const PLATFORM = "MillionSend <hello@ms.example>";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.stubEnv("ONBOARDING_EMAIL_FROM", PLATFORM);
  vi.stubEnv("APP_BASE_URL", "https://app.example.test");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

/** A team whose owner is Ada; Bob, an admin, is the one signed in unless said otherwise. */
async function seedTeam(slug: string, opts: { ownerVerified?: boolean } = {}) {
  const teamId = await createTeam(db, slug);
  await db.insert(schema.user).values([
    {
      id: `${slug}-ada`,
      name: "Ada",
      email: `ada@${slug}.example`,
      emailVerified: opts.ownerVerified ?? true,
    },
    { id: `${slug}-bob`, name: "Bob", email: `bob@${slug}.example`, emailVerified: true },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: `${slug}-ada`, role: "owner" },
    { teamId, userId: `${slug}-bob`, role: "admin" },
  ]);
  return teamId;
}

function caller(teamId: string, slug: string, enqueued: string[] = []) {
  const ctx: Context = {
    db,
    session: { user: { id: `${slug}-bob`, email: `bob@${slug}.example`, name: "Bob" } },
    teamId,
    role: "admin",
    enqueueEmailSend: async (id) => {
      enqueued.push(id);
    },
  };
  return createCaller(ctx);
}

const teamEmails = (teamId: string) =>
  db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId));

describe("onboarding.sendFirstEmail", () => {
  it("sends the fixed email from the shared sender to the owner, once per team", async () => {
    const teamId = await seedTeam("team-a");
    const enqueued: string[] = [];
    const c = caller(teamId, "team-a", enqueued);

    const first = await c.onboarding.sendFirstEmail({ locale: "pt-BR" });
    expect(first).toEqual({ sent: true, id: expect.any(String), to: "ada@team-a.example" });
    const [row] = await teamEmails(teamId);
    expect(row).toMatchObject({
      domainId: null,
      apiKeyId: null,
      from: PLATFORM,
      to: ["ada@team-a.example"],
      subject: "Funciona.",
      latestStatus: "queued",
    });
    expect(enqueued).toEqual([row?.id]);

    // Every later press sends nothing.
    expect(await c.onboarding.sendFirstEmail({ locale: "en" })).toEqual({ sent: false });
    expect(await c.onboarding.sendFirstEmail({ locale: "pt-BR" })).toEqual({ sent: false });
    expect(await teamEmails(teamId)).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    const [team] = await db
      .select({ sentAt: schema.teams.onboardingEmailSentAt })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    expect(team?.sentAt).toBeInstanceOf(Date);
  });

  it("carries the fixed template only: nothing from the team, its name included", async () => {
    const keyring = EnvKeyring.fromBase64(MASTER_KEY);
    const expected = buildOnboardingEmail({
      locale: "en",
      dashboardUrl: "https://app.example.test/emails",
    });
    for (const [slug, name] of [
      ["named-a", "Acme Security Team"],
      ["named-b", "Reset your password at evil.example"],
    ] as const) {
      const teamId = await seedTeam(slug);
      await db.update(schema.teams).set({ name }).where(eq(schema.teams.id, teamId));
      expect(await caller(teamId, slug).onboarding.sendFirstEmail({ locale: "en" })).toMatchObject({
        sent: true,
      });
      const [row] = await teamEmails(teamId);
      if (
        !row?.bodyCiphertext ||
        !row.bodyIv ||
        !row.bodyWrappedDek ||
        row.bodyKeyVersion === null
      ) {
        throw new Error("body missing");
      }
      const body = await decryptEmailBody(
        {
          ciphertext: row.bodyCiphertext,
          iv: row.bodyIv,
          wrappedDek: row.bodyWrappedDek,
          keyVersion: row.bodyKeyVersion,
        },
        keyring,
        { teamId, rowId: row.id },
      );
      expect({ subject: row.subject, html: body.html, text: body.text }).toEqual(expected);
    }
  });

  it("goes to a verified owner only, where the instance verifies, and a refusal leaves the team free to try again", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <auth@ms.example>");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    const teamId = await seedTeam("team-b", { ownerVerified: false });
    const c = caller(teamId, "team-b");
    await expect(c.onboarding.sendFirstEmail({ locale: "en" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await teamEmails(teamId)).toEqual([]);

    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, "team-b-ada"));
    // Refused inside the claim's transaction: the claim rolls back with it.
    await db.insert(schema.suppressions).values({
      teamId,
      email: "ada@team-b.example",
      emailHash: hashRecipient("ada@team-b.example"),
      reason: "hard_bounce",
    });
    await expect(c.onboarding.sendFirstEmail({ locale: "en" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "all_suppressed",
    });
    await db.delete(schema.suppressions).where(eq(schema.suppressions.teamId, teamId));
    expect(await c.onboarding.sendFirstEmail({ locale: "en" })).toMatchObject({
      sent: true,
      to: "ada@team-b.example",
    });
  });

  it("refuses a missing captcha token when Turnstile is on", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4BBB");
    const teamId = await seedTeam("team-c");
    await expect(
      caller(teamId, "team-c").onboarding.sendFirstEmail({ locale: "en" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is unavailable when no shared sender is configured", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "");
    const teamId = await seedTeam("team-d");
    await expect(
      caller(teamId, "team-d").onboarding.sendFirstEmail({ locale: "en" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
