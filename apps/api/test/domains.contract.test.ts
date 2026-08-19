import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DkimVerificationStatus, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for domain management: the official `resend` npm SDK
 * against a live MillionSend API with a stubbed SES identity client —
 * domains.create/list/get/update/verify/remove.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;

// Toggled per test: flipping these flips what the fake SES/DNS answer.
const state: { dkimStatus: DkimVerificationStatus; verifiedForSending: boolean } = {
  dkimStatus: "PENDING",
  verifiedForSending: false,
};
/** DKIM public keys by domain name, captured at create for the DNS fake. */
const dkimKeys = new Map<string, string>();

const fakeSes: SesIdentityClient = {
  async send(command) {
    if (command.constructor.name === "GetEmailIdentityCommand") {
      return {
        VerifiedForSendingStatus: state.verifiedForSending,
        DkimAttributes: { Status: state.dkimStatus },
        MailFromAttributes: {
          MailFromDomainStatus: state.verifiedForSending ? "SUCCESS" : "PENDING",
        },
      };
    }
    return {};
  },
};

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "domains-contract");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const app = createApi({
    db,
    keyring,
    isCloud: false,
    enqueueEmailSend: async () => {},
    ses: {
      clientForRegion: () => fakeSes,
      dns: {
        // Answers exactly the records SES's checklist requires, keyed off the
        // captured per-domain DKIM key — so verify passes when `state` says so.
        resolveTxt: async (name: string) => {
          for (const [domain, pub] of dkimKeys) {
            if (name === `millionsend._domainkey.${domain}`) {
              return [[`v=DKIM1; k=rsa; p=${pub}`]];
            }
            if (name === `send.${domain}`) return [["v=spf1 include:amazonses.com ~all"]];
          }
          return [];
        },
        resolveMx: async (name: string) =>
          name.startsWith("send.")
            ? [{ priority: 10, exchange: "feedback-smtp.us-east-1.amazonses.com" }]
            : [],
        resolveCname: async () => [],
      },
      defaultRegion: "us-east-1",
    },
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  resend = new Resend(key.token, { baseUrl: `http://127.0.0.1:${address.port}` });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

async function captureDkimKey(domainName: string): Promise<void> {
  const [row] = await db
    .select({ pub: schema.domains.dkimPublicKey })
    .from(schema.domains)
    .where(eq(schema.domains.name, domainName));
  dkimKeys.set(domainName, row?.pub ?? "");
}

describe("official resend SDK: domains", () => {
  let domainId: string;

  it("creates a domain and returns its DNS records", async () => {
    const created = await resend.domains.create({ name: "mail.example.com" });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({
      name: "mail.example.com",
      status: "pending",
      region: "us-east-1",
      capabilities: { sending: "enabled", receiving: "disabled" },
    });
    domainId = created.data?.id ?? "";
    const records = created.data?.records ?? [];
    expect(records.some((r) => r.record === "DKIM")).toBe(true);
    expect(records.some((r) => r.record === "SPF")).toBe(true);
    for (const r of records) expect(r.status).toBe("not_started");
    await captureDkimKey("mail.example.com");
  });

  it("409s a duplicate domain name", async () => {
    const dup = await resend.domains.create({ name: "mail.example.com" });
    expect(dup.data).toBeNull();
    expect(dup.error?.statusCode).toBe(409);
  });

  it("lists domains in the list envelope", async () => {
    const listed = await resend.domains.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.object).toBe("list");
    expect(listed.data?.has_more).toBe(false);
    expect(listed.data?.data.map((d) => d.id)).toEqual([domainId]);
  });

  it("gets a domain with SES-derived record statuses", async () => {
    state.dkimStatus = "SUCCESS";
    state.verifiedForSending = true;
    const fetched = await resend.domains.get(domainId);
    expect(fetched.error).toBeNull();
    expect(fetched.data).toMatchObject({ object: "domain", id: domainId, status: "pending" });
    const records = fetched.data?.records ?? [];
    expect(records.find((r) => r.record === "DKIM")?.status).toBe("verified");
  });

  it("updates tracking configuration", async () => {
    const updated = await resend.domains.update({ id: domainId, clickTracking: false });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ object: "domain", id: domainId });
    const [row] = await db
      .select({ clickTracking: schema.domains.clickTracking })
      .from(schema.domains)
      .where(eq(schema.domains.id, domainId));
    expect(row?.clickTracking).toBe(false);
  });

  it("verify flips the domain to verified when SES and DNS pass", async () => {
    state.dkimStatus = "SUCCESS";
    state.verifiedForSending = true;
    const verified = await resend.domains.verify(domainId);
    expect(verified.error).toBeNull();
    expect(verified.data).toMatchObject({ object: "domain", id: domainId });

    const fetched = await resend.domains.get(domainId);
    expect(fetched.data?.status).toBe("verified");
  });

  it("removes a domain, then get 404s", async () => {
    const removed = await resend.domains.remove(domainId);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ object: "domain", id: domainId, deleted: true });

    const gone = await resend.domains.get(domainId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });
});
