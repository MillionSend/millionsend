import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSignupAllowed, createAuth, resolveBaseUrl } from "@/server/auth";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

describe("a closed instance, end to end", () => {
  it("refuses the second sign-up with the policy, even with email verification on", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("ALLOW_SIGNUP", "false");
    // A sender plus SES reach: verification is required, which is the
    // configuration under which better-auth answers a 403 from user creation
    // with a generic "check your inbox".
    vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.example.com>");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("AWS_DEFAULT_CHAIN", "");
    const auth = createAuth(db, { send: async () => {} });
    // Through the HTTP handler, the way the sign-up form reaches it.
    const signUp = (email: string) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ name: "Ada", email, password: "correct horse battery" }),
        }),
      );
    // The first account is always allowed: initial setup has no other path.
    expect((await signUp("first@example.com")).status).toBe(200);
    const refused = await signUp("second@example.com");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ message: "Signup is disabled." });
    expect(
      await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, "second@example.com")),
    ).toEqual([]);
  });
});

describe("assertSignupAllowed", () => {
  it("allows the first user even with signup disabled", async () => {
    await expect(assertSignupAllowed(db, false)).resolves.toBeUndefined();
  });

  it("blocks registration once a user exists and signup is disabled", async () => {
    await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
    await expect(assertSignupAllowed(db, false)).rejects.toMatchObject({
      status: "FORBIDDEN",
      message: "Signup is disabled.",
    });
  });

  it("allows registration with ALLOW_SIGNUP=true regardless of existing users", async () => {
    await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
    await expect(assertSignupAllowed(db, true)).resolves.toBeUndefined();
  });
});

describe("resolveBaseUrl", () => {
  it("defaults to localhost and warns when unset outside production", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => {
      warned.push(msg);
    };
    try {
      expect(resolveBaseUrl(undefined, "test")).toBe("http://localhost:3000");
    } finally {
      console.warn = original;
    }
    expect(warned.join(" ")).toContain("APP_BASE_URL");
  });

  it("returns APP_BASE_URL when set", () => {
    expect(resolveBaseUrl("https://mail.example.com")).toBe("https://mail.example.com");
  });

  it("rejects an unset APP_BASE_URL in production", () => {
    expect(() => resolveBaseUrl(undefined, "production")).toThrow(/APP_BASE_URL/);
  });
});
