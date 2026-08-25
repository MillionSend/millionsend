import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Structural subset of SESv2Client so callers inject a fake in tests
 * (mirrors SesAccountClient in account.ts).
 */
export interface SesSendClient {
  send(command: SendEmailCommand): Promise<unknown>;
}

/**
 * Real SESv2 client typed for SendEmail. Mirrors createSesAccountClient in
 * account.ts; omitting credentials falls back to the SDK default provider
 * chain.
 */
export function createSesSendClient(options: {
  region: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): SesSendClient {
  const { region, accessKeyId, secretAccessKey } = options;
  return new SESv2Client({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

export interface SimpleEmail {
  /** `Name <user@domain>` or a bare address. */
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * One transactional (system) message via SESv2 Simple content — SES builds
 * the MIME, so no raw-mode machinery is needed outside the worker. No
 * configuration set on purpose: system mail must stay out of the event
 * pipeline, which matches events to team-owned email rows by tag.
 */
export async function sendSimpleEmail(client: SesSendClient, message: SimpleEmail): Promise<void> {
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: message.from,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: message.html, Charset: "UTF-8" },
            Text: { Data: message.text, Charset: "UTF-8" },
          },
        },
      },
    }),
  );
}
