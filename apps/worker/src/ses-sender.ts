import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { SesSender } from "./handlers/send-email.js";

/**
 * Production SesSender over SESv2 raw sending. SES identities are verified
 * per region, so one client per region is cached and each send is keyed by
 * the caller's region (defaultRegion when none is given).
 */
export function createSesSender(defaultRegion: string): SesSender {
  const clients = new Map<string, SESv2Client>();
  const clientFor = (region: string): SESv2Client => {
    let client = clients.get(region);
    if (!client) {
      client = new SESv2Client({ region });
      clients.set(region, client);
    }
    return client;
  };
  return {
    async sendRaw({ raw, emailId, configurationSetName, region }) {
      const out = await clientFor(region ?? defaultRegion).send(
        new SendEmailCommand({
          Content: { Raw: { Data: raw } },
          EmailTags: [{ Name: "millionsend_email_id", Value: emailId }],
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
