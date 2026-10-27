import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, REAL_NAMES, REFUSED_NAMES } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";

const BASE = "http://localhost:3000";

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
  vi.unstubAllGlobals();
  await close();
});

async function signUp(auth: Auth, email: string, headers: Record<string, string> = {}) {
  const { headers: resHeaders, response } = await auth.api.signUpEmail({
    body: { name: email.split("@")[0] ?? email, email, password: "correct horse battery" },
    headers: new Headers(headers),
    returnHeaders: true,
  });
  const cookie = resHeaders
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: response.user.id, cookie };
}

async function signupRecord(userId: string) {
  const [row] = await db
    .select({ ip: schema.accountSignups.ip, userAgent: schema.accountSignups.userAgent })
    .from(schema.accountSignups)
    .where(eq(schema.accountSignups.userId, userId));
  return row ?? null;
}

async function sessionIp(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ ipAddress: schema.session.ipAddress })
    .from(schema.session)
    .where(eq(schema.session.userId, userId));
  return row?.ipAddress ?? null;
}

describe("display names", () => {
  const post = (auth: Auth, path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: JSON.stringify(body),
      }),
    );
  const password = "correct horse battery";

  it("sign-up and the profile endpoint refuse a name that could read as a link or hide characters", async () => {
    const auth = createAuth(db);
    for (const [i, name] of REFUSED_NAMES.entries()) {
      const res = await post(auth, "/sign-up/email", {
        name,
        email: `n${i}@example.com`,
        password,
      });
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toMatchObject({
        code: "INVALID_NAME",
        message:
          "Names can't contain links, email addresses, phone numbers, line breaks or hidden characters, and can be up to 64 characters long.",
      });
    }
    const portuguese = await post(
      auth,
      "/sign-up/email",
      { name: REFUSED_NAMES[0], email: "pt@example.com", password },
      { "accept-language": "pt-BR" },
    );
    expect(await portuguese.json()).toMatchObject({
      message:
        "Nomes não podem ter links, endereços de e-mail, números de telefone, quebras de linha nem caracteres invisíveis, e podem ter até 64 caracteres.",
    });
    expect(await db.select().from(schema.user)).toEqual([]);

    // A name that only looks like a domain is a company's name.
    const created = await post(auth, "/sign-up/email", {
      name: "acme.dev",
      email: "ada@example.com",
      password,
    });
    expect(created.status).toBe(200);
    const cookie = created.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    for (const name of REFUSED_NAMES) {
      const res = await post(auth, "/update-user", { name }, { cookie });
      expect(res.status, name).toBe(400);
    }
    expect(await db.select({ name: schema.user.name }).from(schema.user)).toEqual([
      { name: "acme.dev" },
    ]);
    for (const name of REAL_NAMES) {
      expect((await post(auth, "/update-user", { name }, { cookie })).status, name).toBe(200);
    }
  });
});

describe("client IP resolution", () => {
  it("self-host: walks a forwarded chain past the loopback proxy instead of discarding it", async () => {
    const auth = createAuth(db);
    // nginx appends its view of the client after whatever the client sent.
    const { userId } = await signUp(auth, "ada@example.com", {
      "x-forwarded-for": "198.51.100.200, 203.0.113.9, 127.0.0.1",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0",
    });
    expect(await sessionIp(userId)).toBe("203.0.113.9");
    expect(await signupRecord(userId)).toEqual({
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0",
    });
  });

  it("cloud: reads cf-connecting-ip and ignores X-Forwarded-For", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const auth = createAuth(db);
    const { userId } = await signUp(auth, "ada@example.com", {
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.200",
    });
    expect(await sessionIp(userId)).toBe("203.0.113.9");
    expect(await signupRecord(userId)).toEqual({ ip: "203.0.113.9", userAgent: null });
  });
});

describe("Turnstile on Google and GitHub sign-in", () => {
  const signInSocial = (auth: Auth, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: JSON.stringify({ provider: "github", callbackURL: "/emails" }),
      }),
    );

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "github-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-secret");
  });

  it("refuses a missing or rejected token before the provider is asked", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4BBB");
    const verified: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const { response } = JSON.parse(String(init?.body)) as { response: string };
      verified.push(response);
      return Response.json({ success: response === "good-token" });
    });
    const auth = createAuth(db);

    const missing = await signInSocial(auth);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "MISSING_RESPONSE" });
    const rejected = await signInSocial(auth, { "x-captcha-response": "bad-token" });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(verified).toEqual(["bad-token"]);

    const passed = await signInSocial(auth, { "x-captcha-response": "good-token" });
    expect(passed.status).toBe(200);
    expect(((await passed.json()) as { url: string }).url).toContain("https://github.com/");
  });

  it("asks for no token on an instance without Turnstile keys", async () => {
    expect((await signInSocial(createAuth(db))).status).toBe(200);
  });
});

describe("account deletion", () => {
  it("refuses while the user is a team's only owner, then deletes with cascades", async () => {
    const auth = createAuth(db);
    const teamId = await createTeam(db);
    const ada = await signUp(auth, "ada@example.com");
    await db.insert(schema.teamMembers).values({ teamId, userId: ada.userId, role: "owner" });

    await expect(
      auth.api.deleteUser({ headers: new Headers({ cookie: ada.cookie }), body: {} }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(await db.select().from(schema.user)).toHaveLength(1);

    const bob = await signUp(auth, "bob@example.com");
    await db.insert(schema.teamMembers).values({ teamId, userId: bob.userId, role: "owner" });
    await expect(
      auth.api.deleteUser({ headers: new Headers({ cookie: ada.cookie }), body: {} }),
    ).resolves.toMatchObject({ success: true });
    expect((await db.select().from(schema.user)).map((u) => u.id)).toEqual([bob.userId]);
    expect(
      await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, ada.userId)),
    ).toHaveLength(0);
    // The sign-up record outlives the account; the retention sweep dates it.
    expect(await signupRecord(ada.userId)).not.toBeNull();
  });
});
