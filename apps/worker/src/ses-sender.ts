import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { parseMailbox } from "@millionsend/core";
import type { SesSender } from "./handlers/send-email.js";

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
 * How long one send may wait on SES, the SDK's retries included: far inside
 * the 15 minutes after which the stalled-claim sweep fails a claimed row.
 */
const SEND_DEADLINE_MS = 60_000;

/**
 * Production SesSender over SESv2 raw sending. SES identities are verified
 * per region, so one client per region is cached and each send is keyed by
 * the caller's region (defaultRegion when none is given).
 */
export function createSesSender(defaultRegion: string, deadlineMs = SEND_DEADLINE_MS): SesSender {
  const clients = new Map<string, SESv2Client>();
  const clientFor = (region: string): SESv2Client => {
    let client = clients.get(region);
    if (!client) {
      // A connection that never opens sent nothing: it fails fast and stays
      // retryable instead of running into the send deadline.
      client = new SESv2Client({ region, requestHandler: { connectionTimeout: 10_000 } });
      clients.set(region, client);
    }
    return client;
  };
  return {
    async sendRaw({ raw, emailId, configurationSetName, region, to, cc, bcc, tenantName }) {
      const ToAddresses = toAddrSpecs(to);
      if (!ToAddresses) throw new Error("no envelope recipients; refusing to send");
      const CcAddresses = toAddrSpecs(cc);
      const BccAddresses = toAddrSpecs(bcc);
      const deadline = AbortSignal.timeout(deadlineMs);
      const out = await clientFor(region ?? defaultRegion)
        .send(
          new SendEmailCommand({
            Content: { Raw: { Data: raw } },
            Destination: {
              ToAddresses,
              ...(CcAddresses ? { CcAddresses } : {}),
              ...(BccAddresses ? { BccAddresses } : {}),
            },
            EmailTags: [{ Name: "millionsend_email_id", Value: emailId }],
            ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
            ...(tenantName ? { TenantName: tenantName } : {}),
          }),
          // Not a per-attempt requestTimeout: the SDK retries that by sending
          // the request again, while past this deadline no attempt goes out.
          { abortSignal: deadline },
        )
        .catch((err: unknown) => {
          // Cut off while SES's answer was arriving, the send fails with the
          // socket's error rather than the abort. Past the deadline, anything
          // but SES's own answer is a send SES may hold.
          if (deadline.aborted && (err as { $fault?: unknown } | null)?.$fault === undefined) {
            throw Object.assign(new Error("SES send passed its deadline", { cause: err }), {
              name: "AbortError",
            });
          }
          throw err;
        });
      if (!out.MessageId) {
        throw new Error("SES accepted the send but returned no MessageId");
      }
      return { messageId: out.MessageId };
    },
  };
}
