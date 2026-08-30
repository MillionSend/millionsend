import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { parseMailbox } from "@millionsend/core";
import type { SesSender } from "./handlers/send-email.js";

type SendRawParams = Parameters<SesSender["sendRaw"]>[0] & {
  to?: readonly string[] | undefined;
  cc?: readonly string[] | null | undefined;
  bcc?: readonly string[] | null | undefined;
};

/**
 * Envelope recipients are derived from the stored, validated recipient
 * fields — never from the raw MIME headers — so a To header can never widen
 * delivery beyond what accept checked (suppression, opt-outs, the cap).
 */
function toAddrSpecs(recipients: readonly string[] | null | undefined): string[] | undefined {
  if (!recipients || recipients.length === 0) return undefined;
  return recipients.map((r) => {
    const mailbox = parseMailbox(r);
    if (!mailbox) throw new Error("recipient is not a single mailbox; refusing to send");
    return mailbox.address;
  });
}

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
    async sendRaw({ raw, emailId, configurationSetName, region, to, cc, bcc }: SendRawParams) {
      const ToAddresses = toAddrSpecs(to);
      const CcAddresses = toAddrSpecs(cc);
      const BccAddresses = toAddrSpecs(bcc);
      const out = await clientFor(region ?? defaultRegion).send(
        new SendEmailCommand({
          Content: { Raw: { Data: raw } },
          ...(ToAddresses
            ? {
                Destination: {
                  ToAddresses,
                  ...(CcAddresses ? { CcAddresses } : {}),
                  ...(BccAddresses ? { BccAddresses } : {}),
                },
              }
            : {}),
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
