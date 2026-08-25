import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SimpleEmail } from "@millionsend/ses";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth";
import {
  buildResetEmail,
  passwordRecoveryEnabled,
  RESET_EMAIL_THROTTLE_MS,
  type SystemMailDeps,
  sendPasswordResetEmail,
} from "@/server/system-mail";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubRecoveryEnv() {
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.example.com>");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("AWS_DEFAULT_CHAIN", "");
}

describe("passwordRecoveryEnabled", () => {
  it("requires SES credentials AND a sender address", () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_DEFAULT_CHAIN", "");
    expect(passwordRecoveryEnabled()).toBe(false);

    vi.stubEnv("AUTH_EMAIL_FROM", "no-reply@mail.example.com");
    expect(passwordRecoveryEnabled()).toBe(false);

    vi.stubEnv("AWS_ACCESS_KEY_ID", "k");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "s");
    expect(passwordRecoveryEnabled()).toBe(true);

    vi.stubEnv("AUTH_EMAIL_FROM", "");
    expect(passwordRecoveryEnabled()).toBe(false);
  });

  it("accepts the explicit default-provider-chain opt-in instead of keys", () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "no-reply@mail.example.com");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_DEFAULT_CHAIN", "true");
    expect(passwordRecoveryEnabled()).toBe(true);
  });
});

describe("buildResetEmail", () => {
  beforeEach(stubRecoveryEnv);

  it("localizes and carries the reset link in html and text", () => {
    const en = buildResetEmail({
      to: "ada@example.com",
      name: "Ada",
      url: "https://app.example.com/api/auth/reset-password/tok?callbackURL=%2Freset",
      locale: "en",
    });
    expect(en.subject).toBe("Reset your MillionSend password");
    expect(en.from).toBe("MillionSend <no-reply@mail.example.com>");
    expect(en.text).toContain("Hi Ada,");
    expect(en.text).toContain("https://app.example.com/api/auth/reset-password/tok");
    expect(en.text).toContain("30");
    expect(en.html).toContain("reset-password/tok");

    const pt = buildResetEmail({
      to: "a@b.com",
      name: "Ada",
      url: "https://x.com/r",
      locale: "pt-BR",
    });
    expect(pt.subject).toBe("Redefina sua senha do MillionSend");
  });

  it("escapes the user-controlled name in the html body", () => {
    const mail = buildResetEmail({
      to: "a@b.com",
      name: '<img src="x">',
      url: "https://x.com/r",
      locale: "en",
    });
    expect(mail.html).not.toContain('<img src="x">');
    expect(mail.html).toContain("&lt;img");
  });
});

describe("sendPasswordResetEmail", () => {
  let db: Db;
  let close: () => Promise<void>;
  let sent: SimpleEmail[];
  let deps: SystemMailDeps;
  const user = { id: "u1", email: "ada@example.com", name: "Ada" };

  beforeEach(async () => {
    stubRecoveryEnv();
    ({ db, close } = await createTestDb());
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: user.email });
    sent = [];
    deps = {
      send: async (message) => {
        sent.push(message);
      },
    };
  });

  afterEach(async () => {
    await close();
  });

  /** Mimics the verification row Better Auth writes before invoking the hook. */
  async function requestReset(token: string, request?: Request) {
    await db.insert(schema.verification).values({
      id: `v-${token}`,
      identifier: `reset-password:${token}`,
      value: user.id,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    await sendPasswordResetEmail(
      db,
      { user, url: `https://x.com/r/${token}`, token },
      request,
      deps,
    );
  }

  it("sends once, then silently skips repeats inside the throttle window", async () => {
    await requestReset("tok1");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(user.email);

    await requestReset("tok2");
    expect(sent).toHaveLength(1);
  });

  it("sends again once the previous request left the throttle window", async () => {
    await requestReset("tok1");
    const beforeWindow = new Date(Date.now() - RESET_EMAIL_THROTTLE_MS - 1000);
    await db
      .update(schema.verification)
      .set({ createdAt: beforeWindow })
      .where(eq(schema.verification.id, "v-tok1"));

    await requestReset("tok2");
    expect(sent).toHaveLength(2);
  });

  it("does nothing without a sender configured", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    await requestReset("tok1");
    expect(sent).toHaveLength(0);
  });

  it("localizes from the NEXT_LOCALE cookie, then Accept-Language", async () => {
    await requestReset(
      "tok1",
      new Request("https://x.com", { headers: { cookie: "NEXT_LOCALE=pt-BR" } }),
    );
    expect(sent[0]?.subject).toBe("Redefina sua senha do MillionSend");

    const beforeWindow = new Date(Date.now() - RESET_EMAIL_THROTTLE_MS - 1000);
    await db.update(schema.verification).set({ createdAt: beforeWindow });
    await requestReset(
      "tok2",
      new Request("https://x.com", { headers: { "accept-language": "pt-BR,pt;q=0.9,en;q=0.5" } }),
    );
    expect(sent[1]?.subject).toBe("Redefina sua senha do MillionSend");

    await db.update(schema.verification).set({ createdAt: beforeWindow });
    await requestReset(
      "tok3",
      new Request("https://x.com", { headers: { "accept-language": "de" } }),
    );
    expect(sent[2]?.subject).toBe("Reset your MillionSend password");
  });
});

describe("request-password-reset endpoint", () => {
  it("answers unknown and known emails with the identical response", async () => {
    stubRecoveryEnv();
    vi.stubEnv("BETTER_AUTH_SECRET", "0".repeat(32));
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    const { db, close } = await createTestDb();
    try {
      await db.insert(schema.user).values({ id: "u1", name: "Ada", email: "ada@example.com" });
      const sent: SimpleEmail[] = [];
      const auth = createAuth(db, {
        send: async (message) => {
          sent.push(message);
        },
      });
      const post = (email: string) =>
        auth.handler(
          new Request("http://localhost:3000/api/auth/request-password-reset", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://localhost:3000" },
            body: JSON.stringify({ email }),
          }),
        );

      const known = await post("ada@example.com");
      const unknown = await post("nobody@example.com");
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual(await known.json());

      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("ada@example.com");
      expect(sent[0]?.html).toContain("/reset-password/");
    } finally {
      await close();
    }
  });
});
