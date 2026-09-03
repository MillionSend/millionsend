import { env, notificationsEmailFrom } from "@millionsend/config";
import { createSesSendClient, sendSimpleEmail } from "@millionsend/ses";

export interface SystemMailer {
  send(to: string, message: { subject: string; html: string; text: string }): Promise<void>;
}

/**
 * Account notifications to team owners. Sent as SES Simple content with no
 * configuration set, so system mail never enters the event pipeline that is
 * tag-joined to team email rows. Without a configured sender the mailer is a
 * no-op: the webhook events still carry the same facts.
 */
export function createSystemMailer(): SystemMailer {
  const from = notificationsEmailFrom();
  if (!from) {
    console.warn(
      "system mail: NOTIFICATIONS_EMAIL_FROM and AUTH_EMAIL_FROM are unset — account emails are skipped, webhook events still fire",
    );
    return { send: async () => {} };
  }
  const client = createSesSendClient({
    region: env.AWS_REGION,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : {}),
  });
  return { send: (to, message) => sendSimpleEmail(client, { from, to, ...message }) };
}
