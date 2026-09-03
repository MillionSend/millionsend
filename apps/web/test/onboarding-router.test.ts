import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

function caller(teamId: string, enqueued: string[] = []) {
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "Ada@Example.com", name: "Ada" } },
    teamId,
    role: "owner",
    enqueueEmailSend: async (id) => {
      enqueued.push(id);
    },
  };
  return createCaller(ctx);
}

describe("onboarding.sendFirstEmail", () => {
  it("accepts the shared sender to the member's own inbox in the asked locale", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "team-a");
    const enqueued: string[] = [];

    const { id } = await caller(teamId, enqueued).onboarding.sendFirstEmail({ locale: "pt-BR" });

    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({
      teamId,
      domainId: null,
      apiKeyId: null,
      from: "MillionSend <onboarding@ms.example>",
      to: ["Ada@Example.com"],
      subject: "Funciona.",
      latestStatus: "queued",
    });
    expect(enqueued).toEqual([id]);
  });

  it("caps onboarding sends per team and refuses a missing captcha token when Turnstile is on", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "team-a");
    const c = caller(teamId);
    for (let i = 0; i < 5; i++) await c.onboarding.sendFirstEmail({ locale: "en" });
    await expect(c.onboarding.sendFirstEmail({ locale: "en" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });

    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4BBB");
    await expect(
      caller(await createTeam(db, "team-b")).onboarding.sendFirstEmail({ locale: "en" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is unavailable when no shared sender is configured", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "");
    const teamId = await createTeam(db, "team-a");
    await expect(caller(teamId).onboarding.sendFirstEmail({ locale: "en" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});
