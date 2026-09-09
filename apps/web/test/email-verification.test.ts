import type { SystemMailMessage } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { buildVerificationEmail, emailVerificationEnabled } from "@/server/system-mail";

let db: Db;
let close: () => Promise<void>;
let sent: SystemMailMessage[];

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  vi.stubEnv("ALLOW_SIGNUP", "true");
  ({ db, close } = await createTestDb());
  sent = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

function stubSender() {
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.example.com>");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("AWS_DEFAULT_CHAIN", "");
}

const auth = () =>
  createAuth(db, {
    send: async (message) => {
      sent.push(message);
    },
  });

const signUp = (a: ReturnType<typeof createAuth>, email = "ada@example.com") =>
  a.api.signUpEmail({
    body: { name: "Ada", email, password: "correct horse battery", callbackURL: "/verify-email" },
    headers: new Headers({ "accept-language": "pt-BR" }),
  });

const signIn = (a: ReturnType<typeof createAuth>, email = "ada@example.com") =>
  a.api.signInEmail({ body: { email, password: "correct horse battery" } });

describe("email verification", () => {
  it("is gated like password recovery: SES reach plus a system sender", () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    expect(emailVerificationEnabled()).toBe(false);
    stubSender();
    expect(emailVerificationEnabled()).toBe(true);
  });

  it("without a sender, sign-up creates a session as before", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    const res = await signUp(auth());
    expect(res.token).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it("with a sender: no session until the emailed link is opened, then sign-in works", async () => {
    stubSender();
    const a = auth();
    const res = await signUp(a);
    expect(res.token).toBeNull();
    expect(sent).toHaveLength(1);
    // No Request object reaches the hook on a direct API call, so the
    // default locale applies; the request rule is covered by the reset tests.
    expect(sent[0]).toMatchObject({
      kind: "email_verification",
      to: "ada@example.com",
      from: "MillionSend <no-reply@mail.example.com>",
      subject: "Verify your MillionSend email",
    });
    const url = new URL(sent[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? "");
    expect(url.pathname).toBe("/api/auth/verify-email");
    expect(url.searchParams.get("callbackURL")).toBe("/verify-email");

    // Sign-in before verifying is refused and re-sends the link.
    await expect(signIn(a)).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(sent).toHaveLength(2);

    // Over HTTP, as the browser opens the link: the welcome reads its language.
    const opened = await a.handler(new Request(url, { headers: { "accept-language": "pt-BR" } }));
    expect(opened.status).toBe(302);
    const [user] = await db
      .select({ verified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, "ada@example.com"));
    expect(user?.verified).toBe(true);
    // The welcome waits for the address to be its owner's, then follows the
    // language of the request that opened the link.
    expect(sent.map((m) => m.kind)).toEqual([
      "email_verification",
      "email_verification",
      "welcome",
    ]);
    expect(sent[2]).toMatchObject({ to: "ada@example.com", subject: "Bem-vindo ao MillionSend" });
    expect((await signIn(a)).token).toBeTruthy();
    expect(sent).toHaveLength(3);
  });

  it("an account from before verification existed is asked at its next sign-in", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    expect((await signUp(auth())).token).toBeTruthy();
    stubSender();
    await expect(signIn(auth())).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe("email_verification");
  });

  it("the template escapes the name and carries the link in html and text", () => {
    stubSender();
    const mail = buildVerificationEmail({
      to: "a@b.com",
      name: '<img src="x">',
      url: "https://x.com/v?token=t",
      locale: "en",
    });
    expect(mail.subject).toBe("Verify your MillionSend email");
    expect(mail.html).not.toContain('<img src="x">');
    expect(mail.html).toContain("&lt;img");
    expect(mail.html).toContain("https://x.com/v?token=t");
    expect(mail.text).toContain("https://x.com/v?token=t");
    expect(mail.text).toContain("60");
    expect(
      buildVerificationEmail({
        to: "a@b.com",
        name: "Ada",
        url: "https://x.com/v",
        locale: "pt-BR",
      }).subject,
    ).toBe("Confirme seu e-mail do MillionSend");
  });
});
