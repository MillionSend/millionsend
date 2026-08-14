import { type SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { SesSender } from "./handlers/send-email.js";

/** Production SesSender over SESv2 raw sending. */
export function createSesSender(client: SESv2Client): SesSender {
  return {
    async sendRaw({ raw, configurationSetName }) {
      const out = await client.send(
        new SendEmailCommand({
          Content: { Raw: { Data: raw } },
          ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
        }),
      );
      if (!out.MessageId) {
        throw new Error("SES accepted the send but returned no MessageId");
      }
      return { messageId: out.MessageId };
    },
  };
}
