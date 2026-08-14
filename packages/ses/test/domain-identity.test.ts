import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import {
  createDomainIdentity,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  getDomainVerification,
  type SesIdentityClient,
} from "../src/domain-identity.js";

const TOKENS = ["tok1aaa", "tok2bbb", "tok3ccc"];

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

describe("dnsRecordsForDomain", () => {
  it("derives the exact DKIM, MAIL FROM, SPF, and DMARC records", () => {
    const records = dnsRecordsForDomain({
      domain: "updates.example.com",
      dkimTokens: TOKENS,
      mailFromSubdomain: "send",
      region: "sa-east-1",
    });
    expect(records).toEqual([
      {
        group: "verification",
        type: "CNAME",
        name: "tok1aaa._domainkey.updates.example.com",
        value: "tok1aaa.dkim.amazonses.com",
      },
      {
        group: "verification",
        type: "CNAME",
        name: "tok2bbb._domainkey.updates.example.com",
        value: "tok2bbb.dkim.amazonses.com",
      },
      {
        group: "verification",
        type: "CNAME",
        name: "tok3ccc._domainkey.updates.example.com",
        value: "tok3ccc.dkim.amazonses.com",
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
  it("creates the identity, sets MAIL FROM, and returns the DKIM tokens", async () => {
    const { client, calls } = fakeClient((command) =>
      command instanceof CreateEmailIdentityCommand ? { DkimAttributes: { Tokens: TOKENS } } : {},
    );
    const result = await createDomainIdentity(client, {
      domain: "example.com",
      mailFromSubdomain: "send",
    });
    expect(result.dkimTokens).toEqual(TOKENS);

    expect(calls).toHaveLength(2);
    const [create, mailFrom] = calls;
    expect(create).toBeInstanceOf(CreateEmailIdentityCommand);
    expect((create as CreateEmailIdentityCommand).input).toEqual({ EmailIdentity: "example.com" });
    expect(mailFrom).toBeInstanceOf(PutEmailIdentityMailFromAttributesCommand);
    expect((mailFrom as PutEmailIdentityMailFromAttributesCommand).input).toEqual({
      EmailIdentity: "example.com",
      MailFromDomain: "send.example.com",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
  });
});

describe("getDomainVerification", () => {
  it("maps GetEmailIdentity output", async () => {
    const { client, calls } = fakeClient(() => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: TOKENS },
      MailFromAttributes: { MailFromDomainStatus: "SUCCESS" },
    }));
    const verification = await getDomainVerification(client, { domain: "example.com" });
    expect(verification).toEqual({
      dkimStatus: "SUCCESS",
      verifiedForSending: true,
      mailFromStatus: "SUCCESS",
      dkimTokens: TOKENS,
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
      dkimTokens: [],
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
