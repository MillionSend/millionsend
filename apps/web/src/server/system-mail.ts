import { env, isCloudDeployment, notificationsEmailFrom } from "@millionsend/config";
import { type SystemMailMessage, sendSystemMail } from "@millionsend/core";
import { EMAIL_WORDMARK_URL, escapeHtml } from "@millionsend/core/html";
import { type Db, getDb, schema } from "@millionsend/db";
import { createSesSendClient, sendSimpleEmail } from "@millionsend/ses";
import { and, eq, gt, like, ne } from "drizzle-orm";
import enInvite from "../../messages/en/invite-email.json";
import en from "../../messages/en/reset-email.json";
import enVerify from "../../messages/en/verify-email.json";
import ptBRInvite from "../../messages/pt-BR/invite-email.json";
import ptBR from "../../messages/pt-BR/reset-email.json";
import ptBRVerify from "../../messages/pt-BR/verify-email.json";
import { getKeyring } from "./keyring";
import { localeFromRequest } from "./locale";
import { enqueueEmailSend } from "./queue";

export const RESET_TOKEN_TTL_MINUTES = 30;
export const VERIFY_TOKEN_TTL_MINUTES = 60;

/** Repeat reset requests for the same account inside this window send nothing. */
export const RESET_EMAIL_THROTTLE_MS = 2 * 60 * 1000;

const MESSAGES = { en, "pt-BR": ptBR } as const;
const INVITE_MESSAGES = { en: enInvite, "pt-BR": ptBRInvite } as const;
const VERIFY_MESSAGES = { en: enVerify, "pt-BR": ptBRVerify } as const;
export type MailLocale = keyof typeof MESSAGES;

/**
 * Honest "this process can reach SES": explicit keys, or the operator's
 * explicit opt-in to the SDK default provider chain. AWS_DEFAULT_CHAIN is
 * read raw — it is an opt-in flag outside the validated env schema.
 */
export function awsCredentialsConfigured(): boolean {
  return (
    Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
    process.env.AWS_DEFAULT_CHAIN === "true" ||
    process.env.AWS_DEFAULT_CHAIN === "1"
  );
}

/**
 * Password recovery exists only when this instance can actually deliver the
 * reset email: SES reachable and a system sender configured. The sign-in
 * screen hides the link and the reset endpoint stays disabled otherwise.
 */
export function passwordRecoveryEnabled(): boolean {
  return awsCredentialsConfigured() && Boolean(env.AUTH_EMAIL_FROM);
}

/**
 * Email verification exists on the same terms: an instance that cannot
 * deliver the link cannot demand it. When on, a password sign-up gets no
 * session until the emailed link is opened, and an account that predates it
 * verifies at its next sign-in (the link is re-sent then); open sessions are
 * untouched. Social sign-ins arrive verified by their provider.
 */
export function emailVerificationEnabled(): boolean {
  return passwordRecoveryEnabled();
}

const MUTED = 'style="font-size:13px;line-height:1.5;color:#52525b;margin:24px 0 0"';

/**
 * Fills `{key}` placeholders. A replacer function, not a replacement string:
 * user-controlled values such as names may contain `$'` / `$$`, which
 * String.replace would otherwise interpret. Every occurrence is filled.
 */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * The one account-mail layout: wordmark, white card, paragraphs, a button,
 * the link as text, muted footers. Everything is escaped here, so the
 * catalogs stay plain text.
 */
function accountMailCard(input: {
  paragraphs: string[];
  button: string;
  url: string;
  linkFallback: string;
  muted: string[];
}): { html: string; text: string } {
  const url = escapeHtml(input.url);
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 12px">${escapeHtml(p)}</p>`,
    )
    .join("\n    ");
  const muted = input.muted.map((m) => `<p ${MUTED}>${escapeHtml(m)}</p>`).join("\n    ");
  const html = `<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <img src="${EMAIL_WORDMARK_URL}" width="174" height="24" alt="MillionSend" style="display:block;height:24px;width:auto;margin:0 0 24px;border:0">
    ${paragraphs}
    <a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;padding:12px 20px;margin-top:12px">${escapeHtml(input.button)}</a>
    <p ${MUTED}>${escapeHtml(input.linkFallback)}<br><a href="${url}" style="color:#18181b;word-break:break-all">${url}</a></p>
    ${muted}
  </div>
</div>`;
  const text = `${input.paragraphs.join("\n\n")}\n\n${input.url}\n\n${input.muted.join("\n\n")}\n`;
  return { html, text };
}

/** Exported for tests; interpolates and escapes, so strings stay in JSON. */
export function buildResetEmail(input: {
  to: string;
  name: string;
  url: string;
  locale: MailLocale;
}): SystemMailMessage {
  const m = MESSAGES[input.locale];
  const greeting = fill(m.greeting, { name: input.name });
  const expiry = fill(m.expiry, { minutes: String(RESET_TOKEN_TTL_MINUTES) });
  return {
    from: env.AUTH_EMAIL_FROM ?? "",
    to: input.to,
    subject: m.subject,
    ...accountMailCard({
      paragraphs: [greeting, m.body],
      button: m.button,
      url: input.url,
      linkFallback: m.linkFallback,
      muted: [`${expiry} ${m.ignore}`],
    }),
    kind: "password_reset",
  };
}

/** Exported for tests. Same card as the reset, from the same sender. */
export function buildVerificationEmail(input: {
  to: string;
  name: string;
  url: string;
  locale: MailLocale;
}): SystemMailMessage {
  const m = VERIFY_MESSAGES[input.locale];
  const greeting = fill(m.greeting, { name: input.name });
  const expiry = fill(m.expiry, { minutes: String(VERIFY_TOKEN_TTL_MINUTES) });
  return {
    from: env.AUTH_EMAIL_FROM ?? "",
    to: input.to,
    subject: m.subject,
    ...accountMailCard({
      paragraphs: [greeting, m.body],
      button: m.button,
      url: input.url,
      linkFallback: m.linkFallback,
      muted: [`${expiry} ${m.ignore}`],
    }),
    kind: "email_verification",
  };
}

/**
 * Exported for tests. The inviter's dashboard locale picks the language: the
 * invitee's own is unknown until they sign in, and teammates usually share one.
 */
export function buildInvitationEmail(input: {
  to: string;
  inviterName: string;
  teamName: string;
  role: "member" | "admin";
  url: string;
  expiresInDays: number;
  locale: MailLocale;
}): SystemMailMessage {
  const m = INVITE_MESSAGES[input.locale];
  const values = {
    inviter: input.inviterName,
    team: input.teamName,
    role: m.roles[input.role],
    days: String(input.expiresInDays),
    email: input.to,
  };
  const subject = fill(m.subject, values);
  const body = fill(m.body, values);
  const expiry = fill(m.expiry, values);
  const noAccount = fill(m.noAccount, values);
  return {
    from: notificationsEmailFrom() ?? "",
    to: input.to,
    subject,
    ...accountMailCard({
      paragraphs: [body],
      button: m.button,
      url: input.url,
      linkFallback: m.linkFallback,
      muted: [noAccount, `${expiry} ${m.ignore}`],
    }),
    kind: "invitation",
  };
}

/** Mail seam so tests capture sends instead of stubbing the pipeline or the AWS SDK. */
export interface SystemMailDeps {
  send(message: SystemMailMessage): Promise<void>;
}

/**
 * Account mail rides the team pipeline when a team holds the sender's
 * verified domain (core sendSystemMail), else SESv2 Simple content as
 * before. Clients are built per send: system mail is rare, so there is
 * nothing worth caching.
 */
export const defaultSystemMailDeps: SystemMailDeps = {
  send: async (message) => {
    await sendSystemMail(
      {
        db: getDb(),
        keyring: getKeyring(),
        isCloud: isCloudDeployment(),
        enqueueEmailSend,
        raw: (m) =>
          sendSimpleEmail(
            createSesSendClient({
              region: env.AWS_REGION,
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            }),
            m,
          ),
      },
      message,
    );
  },
};

/**
 * Better Auth's sendResetPassword hook body. Never throws and never awaits
 * the SES call: the endpoint's response — shape and timing — must not depend
 * on whether or how the send went, or it would leak account existence.
 *
 * Per-account throttle: Better Auth writes a verification row per reset token
 * (identifier `reset-password:<token>`, value = user id) BEFORE invoking this
 * hook, so any other row for this user newer than the window means an email
 * already went out — skip silently, the caller still sees success.
 */
export async function sendPasswordResetEmail(
  db: Db,
  data: { user: { id: string; email: string; name: string }; url: string; token: string },
  request: Request | undefined,
  deps: SystemMailDeps = defaultSystemMailDeps,
): Promise<void> {
  try {
    if (!env.AUTH_EMAIL_FROM) return;
    const cutoff = new Date(Date.now() - RESET_EMAIL_THROTTLE_MS);
    const [recent] = await db
      .select({ id: schema.verification.id })
      .from(schema.verification)
      .where(
        and(
          eq(schema.verification.value, data.user.id),
          like(schema.verification.identifier, "reset-password:%"),
          ne(schema.verification.identifier, `reset-password:${data.token}`),
          gt(schema.verification.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (recent) return;
    const message = buildResetEmail({
      to: data.user.email,
      name: data.user.name,
      url: data.url,
      locale: localeFromRequest(request),
    });
    void deps.send(message).catch((error) => {
      console.error("Password reset email failed to send", error);
    });
  } catch (error) {
    console.error("Password reset email skipped", error);
  }
}

/**
 * Better Auth's sendVerificationEmail hook body, on sign-up and on a sign-in
 * that finds the address unverified. Detached like the reset: the endpoint's
 * response must not depend on the send (a duplicate sign-up already answers
 * generically), and a failure is logged, never surfaced — the screen offers
 * the link again.
 */
export function sendVerificationEmail(
  data: { user: { email: string; name: string }; url: string },
  request: Request | undefined,
  deps: SystemMailDeps = defaultSystemMailDeps,
): void {
  try {
    const message = buildVerificationEmail({
      to: data.user.email,
      name: data.user.name,
      url: data.url,
      locale: localeFromRequest(request),
    });
    void deps.send(message).catch((error) => {
      console.error("Verification email failed to send", error);
    });
  } catch (error) {
    console.error("Verification email skipped", error);
  }
}
