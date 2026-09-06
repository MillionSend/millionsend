import { env, notificationsEmailFrom } from "@millionsend/config";
import {
  type Keyring,
  type SystemMailKind,
  type SystemMailMessage,
  sendSystemMail,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { EMAIL_SEND_PRIORITY, type EmailSendPriority } from "@millionsend/queue";
import { createSesSendClient, sendSimpleEmail } from "@millionsend/ses";

export interface SystemMailer {
  send(
    to: string,
    message: { subject: string; html: string; text: string; kind: SystemMailKind },
  ): Promise<void>;
}

/**
 * Account notifications to team owners and the instance operator. They ride
 * the team pipeline into whichever team holds the sender's verified domain
 * (core sendSystemMail) and go out raw when no team does. Without a
 * configured sender the mailer is a no-op: the webhook events still carry
 * the same facts.
 */
export function createSystemMailer(deps: {
  db: Db;
  keyring: Keyring;
  enqueueSend: (emailId: string, startAfter?: Date, priority?: EmailSendPriority) => Promise<void>;
}): SystemMailer {
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
  const sendDeps = {
    db: deps.db,
    keyring: deps.keyring,
    isCloud: env.IS_CLOUD,
    // The worker's own enqueue defaults to bulk; an owner notification must
    // not queue behind a broadcast fan-out.
    enqueueEmailSend: (emailId: string, opts?: { startAfter?: Date }) =>
      deps.enqueueSend(emailId, opts?.startAfter, EMAIL_SEND_PRIORITY.transactional),
    raw: (m: SystemMailMessage) => sendSimpleEmail(client, m),
  };
  return {
    send: async (to, message) => {
      await sendSystemMail(sendDeps, { from, to, ...message });
    },
  };
}
