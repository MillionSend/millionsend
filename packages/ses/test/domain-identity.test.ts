import { createPublicKey } from "node:crypto";
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  type PutEmailIdentityDkimSigningAttributesCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import {
  createDomainIdentity,
  DKIM_SELECTOR,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  generateDkimKeyPair,
  getDomainVerification,
  type SesIdentityClient,
} from "../src/domain-identity.js";

const DKIM = { selector: DKIM_SELECTOR, privateKeyB64: "cHJpdmF0ZS1rZXk=" };

function fakeClient(respond: (command: object) => unknown = () => ({})) {
  const calls: object[] = [];
  const client: SesIdentityClient = {
    async send(command) {
      calls.push(command);
      return respond(command);
    },
  };
  return { client, calls };
}

describe("generateDkimKeyPair", () => {
  it("produces a 2048-bit RSA pair with matching PKCS#1 private and SPKI public halves", () => {
    const { privateKeyB64, publicKeyB64 } = generateDkimKeyPair();

    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(publicKey.asymmetricKeyType).toBe("rsa");
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);

    // The private half must parse as PKCS#1 (what SES expects) and derive the
    // exact public half published in DNS.
    const derivedPublic = createPublicKey({
      key: Buffer.from(privateKeyB64, "base64"),
      format: "der",
      type: "pkcs1",
    });
    expect(derivedPublic.export({ format: "der", type: "spki" }).toString("base64")).toBe(
      publicKeyB64,
    );
  });

  it("generates a fresh key per call", () => {
    expect(generateDkimKeyPair().publicKeyB64).not.toBe(generateDkimKeyPair().publicKeyB64);
  });
});

describe("dnsRecordsForDomain", () => {
  it("derives the exact DKIM TXT, MAIL FROM, SPF, and DMARC records", () => {
    const records = dnsRecordsForDomain({
      domain: "updates.example.com",
      dkimSelector: "millionsend",
      dkimPublicKey: "PUBKEYB64",
      mailFromSubdomain: "send",
      region: "sa-east-1",
    });
    expect(records).toEqual([
      {
        group: "verification",
        type: "TXT",
        name: "millionsend._domainkey.updates.example.com",
        value: '"v=DKIM1; k=rsa; p=PUBKEYB64"',
      },
      {
        group: "sending",
        type: "MX",
        name: "send.updates.example.com",
        value: "feedback-smtp.sa-east-1.amazonses.com",
        priority: 10,
      },
      {
        group: "sending",
        type: "TXT",
        name: "send.updates.example.com",
        value: '"v=spf1 include:amazonses.com ~all"',
      },
      {
        group: "dmarc",
        type: "TXT",
        name: "_dmarc.updates.example.com",
        value: '"v=DMARC1; p=none;"',
      },
    ]);
  });
});

describe("createDomainIdentity", () => {
  it("creates the identity with BYODKIM signing attributes and sets MAIL FROM", async () => {
    const { client, calls } = fakeClient();
    await createDomainIdentity(client, {
      domain: "example.com",
      mailFromSubdomain: "send",
      dkim: DKIM,
    });

    expect(calls).toHaveLength(2);
    const [create, mailFrom] = calls;
    expect(create).toBeInstanceOf(CreateEmailIdentityCommand);
    expect((create as CreateEmailIdentityCommand).input).toEqual({
      EmailIdentity: "example.com",
      DkimSigningAttributes: {
        DomainSigningSelector: "millionsend",
        DomainSigningPrivateKey: DKIM.privateKeyB64,
      },
    });
    expect(mailFrom).toBeInstanceOf(PutEmailIdentityMailFromAttributesCommand);
    expect((mailFrom as PutEmailIdentityMailFromAttributesCommand).input).toEqual({
      EmailIdentity: "example.com",
      MailFromDomain: "send.example.com",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
  });

  it("adopts an already-existing identity by re-applying the signing key when asked", async () => {
    const { client, calls } = fakeClient((command) => {
      if (command instanceof CreateEmailIdentityCommand) {
        throw Object.assign(new Error("identity exists"), { name: "AlreadyExistsException" });
      }
      return {};
    });
    await createDomainIdentity(client, {
      domain: "example.com",
      mailFromSubdomain: "send",
      dkim: DKIM,
      adoptExisting: true,
    });
    expect(calls.map((c) => c.constructor.name)).toEqual([
      "CreateEmailIdentityCommand",
      "PutEmailIdentityDkimSigningAttributesCommand",
      "PutEmailIdentityMailFromAttributesCommand",
    ]);
    expect((calls[1] as PutEmailIdentityDkimSigningAttributesCommand).input).toEqual({
      EmailIdentity: "example.com",
      SigningAttributesOrigin: "EXTERNAL",
      SigningAttributes: {
        DomainSigningSelector: "millionsend",
        DomainSigningPrivateKey: DKIM.privateKeyB64,
      },
    });
  });

  it("propagates AlreadyExistsException without re-keying unless adoption is enabled", async () => {
    const { client, calls } = fakeClient((command) => {
      if (command instanceof CreateEmailIdentityCommand) {
        throw Object.assign(new Error("identity exists"), { name: "AlreadyExistsException" });
      }
      return {};
    });
    await expect(
      createDomainIdentity(client, {
        domain: "example.com",
        mailFromSubdomain: "send",
        dkim: DKIM,
      }),
    ).rejects.toMatchObject({ name: "AlreadyExistsException" });
    // Neither the signing key nor MAIL FROM of the existing identity is touched.
    expect(calls.map((c) => c.constructor.name)).toEqual(["CreateEmailIdentityCommand"]);
  });

  it("rethrows create failures other than AlreadyExistsException", async () => {
    const { client, calls } = fakeClient((command) => {
      if (command instanceof CreateEmailIdentityCommand) {
        throw Object.assign(new Error("throttled"), { name: "TooManyRequestsException" });
      }
      return {};
    });
    await expect(
      createDomainIdentity(client, {
        domain: "example.com",
        mailFromSubdomain: "send",
        dkim: DKIM,
      }),
    ).rejects.toThrow("throttled");
    expect(calls).toHaveLength(1);
  });
});

describe("getDomainVerification", () => {
  it("maps GetEmailIdentity output", async () => {
    const { client, calls } = fakeClient(() => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS" },
      MailFromAttributes: { MailFromDomainStatus: "SUCCESS" },
    }));
    const verification = await getDomainVerification(client, { domain: "example.com" });
    expect(verification).toEqual({
      dkimStatus: "SUCCESS",
      verifiedForSending: true,
      mailFromStatus: "SUCCESS",
    });
    expect(calls[0]).toBeInstanceOf(GetEmailIdentityCommand);
    expect((calls[0] as GetEmailIdentityCommand).input).toEqual({ EmailIdentity: "example.com" });
  });

  it("defaults missing attributes to unverified", async () => {
    const { client } = fakeClient(() => ({}));
    const verification = await getDomainVerification(client, { domain: "example.com" });
    expect(verification).toEqual({
      dkimStatus: "NOT_STARTED",
      verifiedForSending: false,
      mailFromStatus: "PENDING",
    });
  });
});

describe("deleteDomainIdentity", () => {
  it("deletes the identity", async () => {
    const { client, calls } = fakeClient();
    await deleteDomainIdentity(client, { domain: "example.com" });
    expect(calls[0]).toBeInstanceOf(DeleteEmailIdentityCommand);
    expect((calls[0] as DeleteEmailIdentityCommand).input).toEqual({
      EmailIdentity: "example.com",
    });
  });
});
