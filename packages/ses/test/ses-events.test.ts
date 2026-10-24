import { describe, expect, it } from "vitest";
import { parseSesEvent } from "../src/ses-events.js";

describe("parseSesEvent", () => {
  it("keeps a DeliveryDelay's deliveryDelay object in data", () => {
    const deliveryDelay = {
      timestamp: "2026-03-02T10:15:00.000Z",
      delayType: "MailboxFull",
      expirationTime: "2026-03-03T00:15:00.000Z",
      reportingMTA: "192.0.2.25",
      delayedRecipients: [
        {
          emailAddress: "recipient@example.com",
          status: "4.2.2",
          diagnosticCode: "smtp; 452 4.2.2 Mailbox full",
        },
      ],
    };
    const parsed = parseSesEvent({
      eventType: "DeliveryDelay",
      mail: { messageId: "example-message-id-0001", timestamp: "2026-03-02T10:00:00.000Z" },
      deliveryDelay,
    });

    expect(parsed?.eventType).toBe("DeliveryDelay");
    expect(parsed?.occurredAt.toISOString()).toBe(deliveryDelay.timestamp);
    expect(parsed?.data).toEqual({ eventType: "DeliveryDelay", deliveryDelay });
  });

  it("turns a remote server's U+0000 into U+FFFD, so the event can be queued as jsonb", () => {
    const parsed = parseSesEvent({
      eventType: "Bounce",
      mail: { messageId: "example-message-id-0002", timestamp: "2026-03-02T10:00:00.000Z" },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          { emailAddress: "recipient@example.com", diagnosticCode: "smtp; 550 a\u0000b" },
        ],
      },
    });

    expect(parsed?.bounce?.diagnosticCode).toBe("smtp; 550 a\uFFFDb");
    expect(JSON.stringify(parsed?.data)).not.toContain("\\u0000");
  });

  it("keeps the subtype SES gives a complaint about mail it never attempted", () => {
    const parsed = parseSesEvent({
      eventType: "Complaint",
      mail: { messageId: "example-message-id-0003", timestamp: "2026-03-02T10:00:00.000Z" },
      complaint: {
        complainedRecipients: [{ emailAddress: "recipient@example.com" }],
        complaintSubType: "OnAccountSuppressionList",
        timestamp: "2026-03-02T10:00:01.000Z",
      },
    });

    expect(parsed?.complaint).toEqual({
      recipients: ["recipient@example.com"],
      complaintSubType: "OnAccountSuppressionList",
    });
  });
});
