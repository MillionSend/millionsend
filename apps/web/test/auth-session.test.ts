import { DAY_MS } from "@millionsend/core";
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

describe("new accounts per network", () => {
  // Both headers name the client: the cloud reads cf-connecting-ip, a
  // self-host walks x-forwarded-for.
  const signUpFrom = (auth: Auth, email: string, ip: string, locale = "en") =>
    auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          "cf-connecting-ip": ip,
          "x-forwarded-for": ip,
          "accept-language": locale,
        },
        body: JSON.stringify({ name: "Ada", email, password: "correct horse battery" }),
      }),
    );

  it("cloud: refuses a network's 4th account in a day alike for a new and a held address, verification on", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    // A sender plus SES reach: verification is required, which is when
    // better-auth answers a held address without creating anything.
    vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.example.com>");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("AWS_DEFAULT_CHAIN", "");
    const auth = createAuth(db, { send: async () => {} });
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      expect((await signUpFrom(auth, email, "203.0.113.9")).status, email).toBe(200);
    }

    const fresh = await signUpFrom(auth, "d@example.com", "203.0.113.9");
    const held = await signUpFrom(auth, "a@example.com", "203.0.113.9");
    expect([fresh.status, held.status]).toEqual([429, 429]);
    const refusal = await fresh.json();
    expect(refusal).toMatchObject({
      code: "SIGNUP_IP_LIMIT",
      message: "Too many accounts were created from this network today. Try again later.",
    });
    expect(await held.json()).toEqual(refusal);
    expect(
      await (await signUpFrom(auth, "d@example.com", "203.0.113.9", "pt-BR")).json(),
    ).toMatchObject({
      message: "Muitas contas foram criadas nesta rede hoje. Tente de novo mais tarde.",
    });
    expect((await signUpFrom(auth, "d@example.com", "198.51.100.7")).status).toBe(200);

    // A day on, the network's earlier sign-ups no longer count.
    await db
      .update(schema.accountSignups)
      .set({ createdAt: new Date(Date.now() - DAY_MS - 60_000) });
    expect((await signUpFrom(auth, "e@example.com", "203.0.113.9")).status).toBe(200);
  });

  it("cloud: counts an IPv6 network by its /64", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const auth = createAuth(db);
    for (const [i, ip] of ["2001:db8::1", "2001:db8::2", "2001:db8::3"].entries()) {
      expect((await signUpFrom(auth, `v${i}@example.com`, ip)).status, ip).toBe(200);
    }
    expect((await signUpFrom(auth, "v3@example.com", "2001:db8::ffff")).status).toBe(429);
    expect((await signUpFrom(auth, "v4@example.com", "2001:db8:0:1::1")).status).toBe(200);
  });

  it("self-host: never limits a network", async () => {
    const auth = createAuth(db);
    for (const email of ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]) {
      expect((await signUpFrom(auth, email, "203.0.113.9")).status, email).toBe(200);
    }
    const ips = await db.select({ ip: schema.accountSignups.ip }).from(schema.accountSignups);
    expect(ips.map((row) => row.ip)).toEqual(Array(4).fill("203.0.113.9"));
  });

  it("cloud: sends a GitHub sign-up from a network at its limit back to the form with the code", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    vi.stubEnv("GITHUB_CLIENT_ID", "github-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-secret");
    for (const userId of ["u1", "u2", "u3"]) {
      await db
        .insert(schema.accountSignups)
        .values({ userId, email: `${userId}@example.com`, ip: "203.0.113.9" });
    }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return Response.json({ access_token: "token", token_type: "bearer", scope: "user:email" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 42, login: "ada", name: "Ada", email: "ada@example.com" });
      }
      if (url === "https://api.github.com/user/emails") {
        return Response.json([{ email: "ada@example.com", primary: true, verified: true }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const auth = createAuth(db);
    const client = { "cf-connecting-ip": "203.0.113.9" };
    const started = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...client },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/emails",
          errorCallbackURL: "/signup",
        }),
      }),
    );
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get(
      "state",
    );
    const cookie = started.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const callback = await auth.handler(
      new Request(`${BASE}/api/auth/callback/github?code=code&state=${state}`, {
        headers: { cookie, ...client },
      }),
    );
    expect(callback.status).toBe(302);
    const landed = new URL(callback.headers.get("location") ?? "", BASE);
    expect(landed.pathname).toBe("/signup");
    expect(landed.searchParams.get("error")).toBe("SIGNUP_IP_LIMIT");
    expect(await db.select().from(schema.user)).toEqual([]);
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
