import { accountEmailFrom, env, notificationsEmailFrom, servedRegions } from "@millionsend/config";
import {
  type AccountMailKind,
  accountLocale,
  buildAccountMail,
  findInstanceOperator,
  type Keyring,
  listTeamOwners,
  type MailContent,
  type MailLocale,
  type SenderDomainOwner,
  type SystemMailKind,
  type SystemMailMessage,
  sendSystemMail,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { EMAIL_SEND_PRIORITY, type EmailSendPriority } from "@millionsend/queue";
import { createSesSendClient, sendSimpleEmail } from "@millionsend/ses";

export interface SystemMailer {
  send(to: string, message: Omit<SystemMailMessage, "from" | "to">): Promise<void>;
}

/**
 * Account notifications to team owners and the instance operator. They ride
 * the team pipeline into whichever team holds the sender's verified domain
 * (core sendSystemMail) and go out raw when no team does — from that
 * domain's region when a team holds it, else the default served region.
 * Without a configured sender the mailer is a no-op: the webhook events
 * still carry the same facts.
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
  // Built per send: raw account mail is rare, so there is nothing worth caching.
  const raw = (m: SystemMailMessage, owner: SenderDomainOwner | null) =>
    sendSimpleEmail(
      createSesSendClient({
        region: owner?.region ?? servedRegions()[0] ?? env.AWS_REGION,
        ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : {}),
      }),
      m,
    );
  const sendDeps = {
    db: deps.db,
    keyring: deps.keyring,
    isCloud: env.IS_CLOUD,
    // The worker's own enqueue defaults to bulk; an owner notification must
    // not queue behind a broadcast fan-out.
    enqueueEmailSend: (emailId: string, opts?: { startAfter?: Date }) =>
      deps.enqueueSend(emailId, opts?.startAfter, EMAIL_SEND_PRIORITY.transactional),
    raw,
  };
  return {
    send: async (to, message) => {
      await sendSystemMail(sendDeps, { from, to, ...message });
    },
  };
}

/**
 * One notice to every owner of a team, each in their own language; a
 * failing send is logged and the others still go out. `except` drops an
 * owner who is the subject of the notice; `also` adds a recipient who is
 * not an owner (the person who created a key). Returns how many went out.
 */
export async function mailOwners(
  db: Db,
  mailer: SystemMailer,
  teamId: string,
  kind: SystemMailKind,
  build: (locale: MailLocale) => MailContent,
  opts: { except?: string; also?: { email: string; locale: MailLocale } } = {},
): Promise<number> {
  const owners = await listTeamOwners(db, teamId, accountEmailFrom(), kind);
  const recipients = owners.filter(
    (owner) => owner.email.toLowerCase() !== opts.except?.toLowerCase(),
  );
  if (
    opts.also &&
    !recipients.some((r) => r.email.toLowerCase() === opts.also?.email.toLowerCase())
  ) {
    recipients.push({ email: opts.also.email, name: "", locale: opts.also.locale });
  }
  let sent = 0;
  for (const recipient of recipients) {
    try {
      await mailer.send(recipient.email, { ...build(recipient.locale), kind, aboutTeamId: teamId });
      sent += 1;
    } catch (err) {
      console.error(`system mail: ${kind} to ${recipient.email} failed`, err);
    }
  }
  return sent;
}

/**
 * One catalog notice to the instance operator, in their own language when
 * their contact row says which; nothing goes out when no operator exists.
 * It names no team, so no suspension mutes it.
 * Returns whether it was sent; a failing send is the caller's to log.
 */
export async function mailOperator(
  db: Db,
  mailer: SystemMailer,
  kind: AccountMailKind,
  path: string,
  values: Record<string, string>,
  appBaseUrl: string | undefined,
): Promise<boolean> {
  const operator = await findInstanceOperator(db);
  if (!operator) return false;
  const locale = await accountLocale(db, accountEmailFrom(), operator.email);
  await mailer.send(operator.email, {
    ...buildAccountMail({ kind, locale, url: `${appBaseUrl ?? ""}${path}`, values }),
    kind,
  });
  return true;
}
