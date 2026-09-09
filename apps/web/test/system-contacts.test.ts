import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  ERASED_TOMBSTONE,
  encryptEmailBody,
  eraseRecipient,
  type SystemMailMessage,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: SystemMailMessage[];
const seam = { send: async (message: SystemMailMessage) => void sends.push(message) };
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  vi.stubEnv("ALLOW_SIGNUP", "true");
  // A sender whose domain a team verified; no SES credentials, so the
  // verification gate stays off and sign-up yields a session.
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.example.com>");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
  vi.stubEnv("AWS_DEFAULT_CHAIN", "");
  ({ db, close } = await createTestDb());
  sends = [];
  teamId = await createTeam(db, "owner");
  await db.insert(schema.domains).values({
    teamId,
    name: "mail.example.com",
    region: "us-east-1",
    status: "verified",
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function signUp(auth: Auth, email: string, name = "Ada Lovelace") {
  const { headers, response } = await auth.api.signUpEmail({
    body: { name, email, password: "correct horse battery" },
    headers: new Headers({ "accept-language": "pt-BR,en;q=0.8" }),
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: response.user.id, cookie };
}

const contactsOf = (email: string) =>
  db.select().from(schema.contacts).where(eq(schema.contacts.email, email));

describe("enrollment and the sign-up flag", () => {
  it("a self-host closed to sign-up enrolls nobody, but still welcomes the account it admits", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "false");
    await signUp(createAuth(db, seam), "first@example.com");
    expect(await contactsOf("first@example.com")).toEqual([]);
    expect(sends.map((m) => [m.kind, m.to])).toEqual([["welcome", "first@example.com"]]);
  });

  it("welcomes once, in the sign-up request's language, with the docs and the domains page", async () => {
    await signUp(createAuth(db, seam), "ada@example.com");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      kind: "welcome",
      to: "ada@example.com",
      from: "MillionSend <no-reply@mail.example.com>",
      subject: "Bem-vindo ao MillionSend",
    });
    expect(sends[0]?.text).toContain("Olá, Ada Lovelace");
    expect(sends[0]?.text).toContain("http://localhost:3000/domains");
    expect(sends[0]?.text).toContain("https://docs.millionsend.com");
  });

  it("the cloud enrolls whatever the flag says", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "false");
    vi.stubEnv("IS_CLOUD", "true");
    await signUp(createAuth(db, seam), "first@example.com");
    expect(await contactsOf("first@example.com")).toHaveLength(1);
  });
});

describe("accounts as contacts of the account-mail team", () => {
  it("a sign-up becomes a contact with its name split and its provenance stamped", async () => {
    await signUp(createAuth(db, seam), "ada@example.com");
    const [contact] = await contactsOf("ada@example.com");
    expect(contact).toMatchObject({
      teamId,
      firstName: "Ada",
      lastName: "Lovelace",
      unsubscribed: false,
      properties: { source: "signup", locale: "pt-BR" },
    });
    expect(contact?.properties.signed_up_at).toMatch(/^\d{4}-/);
    const activities = await db
      .select({ type: schema.contactActivities.type })
      .from(schema.contactActivities)
      .where(eq(schema.contactActivities.contactId, contact?.id ?? ""));
    expect(activities).toEqual([{ type: "contact_created" }]);
  });

  it("a closed instance enrolls nobody", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "false");
    await signUp(createAuth(db, seam), "first@example.com");
    expect(await contactsOf("first@example.com")).toHaveLength(0);
  });

  it("without a team owning the sender's domain, nothing is enrolled", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "no-reply@unowned.example.com");
    await signUp(createAuth(db, seam), "ada@example.com");
    expect(await contactsOf("ada@example.com")).toHaveLength(0);
  });

  it("an existing contact is left alone: no duplicate, no re-subscribe", async () => {
    await db.insert(schema.contacts).values({
      teamId,
      email: "Ada@Example.com",
      unsubscribed: true,
      properties: { source: "import" },
    });
    await signUp(createAuth(db, seam), "ada@example.com");
    const rows = await db.select().from(schema.contacts).where(eq(schema.contacts.teamId, teamId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unsubscribed: true, properties: { source: "import" } });
  });

  it("where the instance verifies, a password sign-up enrolls only once the link is opened", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
    const sent: SystemMailMessage[] = [];
    const auth = createAuth(db, { send: async (m) => void sent.push(m) });
    await auth.api.signUpEmail({
      body: { name: "Ada Lovelace", email: "ada@example.com", password: "correct horse battery" },
    });
    // The address was only typed: it may be anyone's inbox.
    expect(await contactsOf("ada@example.com")).toHaveLength(0);
    const url = new URL(sent[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? "");
    await auth.api.verifyEmail({ query: { token: url.searchParams.get("token") ?? "" } });
    expect(await contactsOf("ada@example.com")).toHaveLength(1);
    expect((await contactsOf("ada@example.com"))[0]?.properties.source).toBe("signup");
  });

  it("deleting the account removes the contact and scrubs the address from the team's log", async () => {
    const auth = createAuth(db, seam, {
      eraseRecipient: (teamId, address) => eraseRecipient(db, teamId, address),
    });
    const { cookie } = await signUp(auth, "ada@example.com");
    // A logged password reset addressed to the account, as the pipeline leaves it.
    const body = await encryptEmailBody({ html: "<p>x</p>", text: "x" }, keyring);
    const [logged] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "MillionSend <no-reply@mail.example.com>",
        to: ["ada@example.com"],
        subject: "Reset your password",
        latestStatus: "sent",
        bodyCiphertext: body.ciphertext,
        bodyIv: body.iv,
        bodyWrappedDek: body.wrappedDek,
        bodyKeyVersion: body.keyVersion,
      })
      .returning({ id: schema.emails.id });

    await auth.api.deleteUser({ body: {}, headers: new Headers({ cookie }) });

    expect(await contactsOf("ada@example.com")).toHaveLength(0);
    const [row] = await db
      .select({ to: schema.emails.to })
      .from(schema.emails)
      .where(eq(schema.emails.id, logged?.id ?? ""));
    expect(row?.to).toEqual([ERASED_TOMBSTONE]);
  });
});
