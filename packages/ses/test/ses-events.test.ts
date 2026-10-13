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
});
