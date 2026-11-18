import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    async send(command: { input: unknown }) {
      sent.push(command.input);
      return { MessageId: "mid-1" };
    }
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { createSesSender } = await import("../src/ses-sender.js");

beforeEach(() => {
  sent.length = 0;
});

describe("createSesSender", () => {
  it("passes an explicit Destination built from the validated recipient fields", async () => {
    await createSesSender("us-east-1").sendRaw({
      raw: Buffer.from("To: smuggled@victim.com, ok@example.com\r\n\r\nbody"),
      emailId: "e1",
      to: ["Ok <ok@example.com>"],
      cc: ['"Doe, John" <cc@example.com>'],
    });
    expect(sent[0]).toMatchObject({
      Destination: { ToAddresses: ["ok@example.com"], CcAddresses: ["cc@example.com"] },
    });
    expect((sent[0] as { Destination: object }).Destination).not.toHaveProperty("BccAddresses");
  });

  it("tags the send with its Free pool, and leaves out a pool SES could not carry", async () => {
    const sender = createSesSender("us-east-1");
    const send = (poolOwnerId?: string) =>
      sender.sendRaw({
        raw: Buffer.from(""),
        emailId: "e3",
        to: ["ok@example.com"],
        ...(poolOwnerId ? { poolOwnerId } : {}),
      });
    await send("Pool_Owner-01");
    await send("owner@example.com");
    await send();
    const emailIdTag = { Name: "millionsend_email_id", Value: "e3" };
    expect(sent.map((input) => (input as { EmailTags: unknown }).EmailTags)).toEqual([
      [emailIdTag, { Name: "millionsend_pool", Value: "Pool_Owner-01" }],
      [emailIdTag],
      [emailIdTag],
    ]);
  });

  it("copies only the feedback-id tags to SES, leaving out a value SES could not carry", async () => {
    const sender = createSesSender("us-east-1");
    const send = (tags: Record<string, string> | null) =>
      sender.sendRaw({ raw: Buffer.from(""), emailId: "e4", to: ["ok@example.com"], tags });
    await send({ feedback_id_a: "campaign-42", feedback_id_b: "store_7", plan: "pro" });
    await send({ feedback_id_a: "has:colon", feedback_id_b: "ok" });
    await send(null);
    const emailIdTag = { Name: "millionsend_email_id", Value: "e4" };
    expect(sent.map((input) => (input as { EmailTags: unknown }).EmailTags)).toEqual([
      [
        emailIdTag,
        { Name: "ses:feedback-id-a", Value: "campaign-42" },
        { Name: "ses:feedback-id-b", Value: "store_7" },
      ],
      [emailIdTag, { Name: "ses:feedback-id-b", Value: "ok" }],
      [emailIdTag],
    ]);
  });

  it("refuses to send a stored recipient the strict parser rejects", async () => {
    await expect(
      createSesSender("us-east-1").sendRaw({
        raw: Buffer.from(""),
        emailId: "e2",
        to: ["a@x.com, b@y.com <ok@example.com>"],
      }),
    ).rejects.toThrow(/single mailbox/);
    expect(sent).toHaveLength(0);
  });
});
