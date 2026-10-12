import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { createCaller } from "@/server/routers";

const BASE = "http://localhost:3000";
const password = "correct horse battery";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("ALLOW_SIGNUP", "true");
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const signUp = (auth: ReturnType<typeof createAuth>, email: string, locale = "en") =>
  auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "accept-language": locale },
      body: JSON.stringify({ name: "Ada", email, password }),
    }),
  );

describe("disposable addresses at sign-up", () => {
  it("are refused where the instance blocks them, subdomains included, in the requester's language", async () => {
    vi.stubEnv("BLOCK_DISPOSABLE_EMAILS", "true");
    const auth = createAuth(db);
    for (const email of ["ada@mailinator.com", "ada@sub.mailinator.com", "ada@MAILINATOR.COM"]) {
      const res = await signUp(auth, email);
      expect(res.status, email).toBe(400);
      expect(await res.json(), email).toMatchObject({
        code: "DISPOSABLE_EMAIL",
        message: "Use a permanent email address. Temporary inboxes can't be used to sign up.",
      });
    }
    expect(await (await signUp(auth, "ada@mailinator.com", "pt-BR")).json()).toMatchObject({
      message: "Use um e-mail permanente. Não aceitamos endereços temporários.",
    });
    expect(await db.select().from(schema.user)).toEqual([]);
    expect((await signUp(auth, "ada@acme.dev")).status).toBe(200);
  });

  it("are refused on the cloud by default, and accepted on a self-host that left the block off", async () => {
    expect((await signUp(createAuth(db), "first@mailinator.com")).status).toBe(200);
    vi.stubEnv("IS_CLOUD", "true");
    expect((await signUp(createAuth(db), "second@mailinator.com")).status).toBe(400);
  });

  it("are refused alike whether or not an account already has the address", async () => {
    expect((await signUp(createAuth(db), "held@mailinator.com")).status).toBe(200);
    vi.stubEnv("BLOCK_DISPOSABLE_EMAILS", "true");
    const auth = createAuth(db);
    const held = await signUp(auth, "held@mailinator.com");
    const fresh = await signUp(auth, "fresh@mailinator.com");
    expect([held.status, fresh.status]).toEqual([400, 400]);
    expect(await held.json()).toEqual(await fresh.json());
  });

  it("are refused when an account is created outside the form, as a social sign-in does", async () => {
    vi.stubEnv("BLOCK_DISPOSABLE_EMAILS", "true");
    const ctx = await createAuth(db).$context;
    await expect(
      ctx.internalAdapter.createUser(
        { name: "Ada", email: "ada@sub.mailinator.com", emailVerified: true },
        { method: "oauth", oauth: { providerId: "github" } },
      ),
    ).rejects.toMatchObject({ body: { code: "DISPOSABLE_EMAIL" } });
  });
});

describe("disposable addresses on an email change", () => {
  it("are refused as the new address, and an account that already has one keeps working", async () => {
    const auth = createAuth(db);
    expect((await signUp(auth, "old@mailinator.com")).status).toBe(200);
    expect((await signUp(auth, "ada@acme.dev")).status).toBe(200);
    const [old] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "old@mailinator.com"));
    const [ada] = await db.select().from(schema.user).where(eq(schema.user.email, "ada@acme.dev"));
    if (!old || !ada) throw new Error("accounts missing");

    vi.stubEnv("BLOCK_DISPOSABLE_EMAILS", "true");
    const ctx = await createAuth(db).$context;
    await expect(
      ctx.internalAdapter.updateUser(ada.id, { email: "ada@sub.mailinator.com" }),
    ).rejects.toMatchObject({
      body: {
        code: "DISPOSABLE_EMAIL",
        message: "Use a permanent email address. Temporary inboxes can't be used for an account.",
      },
    });
    await ctx.internalAdapter.updateUser(old.id, {
      email: "old@mailinator.com",
      name: "Still here",
    });
    await ctx.internalAdapter.updateUser(ada.id, { email: "ada@new.acme.dev" });
    expect(
      (
        await db
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(eq(schema.user.id, old.id))
      )[0],
    ).toEqual({ name: "Still here" });
  });
});

describe("disposable addresses in the console", () => {
  it("are tagged on the team's members, whatever the block", async () => {
    await db.insert(schema.user).values([
      { id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) },
      { id: "temp", name: "Temp", email: "temp@sub.mailinator.com" },
    ]);
    const teamId = await createTeam(db, "acme");
    await db.insert(schema.teamMembers).values({ teamId, userId: "temp", role: "owner" });
    const view = await createCaller({
      db,
      session: {
        user: { id: "op", email: "op@example.com", name: "Operator" },
        session: { id: "s-op", createdAt: new Date() },
      },
      teamId: null,
      role: null,
    }).console.accounts.members({ teamId });
    expect(view.members).toMatchObject([{ email: "temp@sub.mailinator.com", disposable: true }]);
  });
});
