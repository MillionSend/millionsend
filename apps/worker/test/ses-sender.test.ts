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
