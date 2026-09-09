import {
  accountEmailFrom,
  accountMailDeliverable,
  env,
  isCloudDeployment,
  notificationsEmailFrom,
} from "@millionsend/config";
import {
  type AccountMailKind,
  accountMailCard,
  accountMailPhrase,
  buildAccountMail,
  fillTemplate as fill,
  type MailLocale,
  type SystemMailMessage,
  sendSystemMail,
} from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { createSesSendClient, sendSimpleEmail } from "@millionsend/ses";
import { and, eq, gt, like, ne } from "drizzle-orm";
import { appBaseUrl } from "@/lib/api-base-url";
import { DOCS_URL } from "@/lib/docs-links";
import enInvite from "../../messages/en/invite-email.json";
import en from "../../messages/en/reset-email.json";
import enUpdates from "../../messages/en/updates.json";
import enVerify from "../../messages/en/verify-email.json";
import ptBRInvite from "../../messages/pt-BR/invite-email.json";
import ptBR from "../../messages/pt-BR/reset-email.json";
import ptBRUpdates from "../../messages/pt-BR/updates.json";
import ptBRVerify from "../../messages/pt-BR/verify-email.json";
import { getKeyring } from "./keyring";
import { localeFromHeaders } from "./locale";
import { enqueueEmailSend } from "./queue";

export const RESET_TOKEN_TTL_MINUTES = 30;
export const VERIFY_TOKEN_TTL_MINUTES = 60;

/** Repeat reset requests for the same account inside this window send nothing. */
export const RESET_EMAIL_THROTTLE_MS = 2 * 60 * 1000;

const MESSAGES = { en, "pt-BR": ptBR } as const;
const INVITE_MESSAGES = { en: enInvite, "pt-BR": ptBRInvite } as const;
const VERIFY_MESSAGES = { en: enVerify, "pt-BR": ptBRVerify } as const;
const UPDATES_MESSAGES = { en: enUpdates.email, "pt-BR": ptBRUpdates.email } as const;

export type { MailLocale };

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
  return accountMailDeliverable();
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

/** The product-updates confirmation link (server/updates.ts), from the account sender. */
export function buildUpdatesConfirmEmail(input: {
  to: string;
  url: string;
  locale: MailLocale;
  expiresInHours?: number;
}): SystemMailMessage {
  const m = UPDATES_MESSAGES[input.locale];
  const expiry = fill(m.expiry, { hours: String(input.expiresInHours ?? 24) });
  return {
    from: accountEmailFrom() ?? "",
    to: input.to,
    subject: m.subject,
    ...accountMailCard({
      paragraphs: [m.greeting, m.body],
      button: m.button,
      url: input.url,
      linkFallback: m.linkFallback,
      muted: [`${expiry} ${m.ignore}`],
    }),
    kind: "updates.confirm",
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

/** One catalog kind, from the account sender, addressed to a person. */
/**
 * One account mail on the shared card; the button opens `path` on this
 * instance unless `url` says elsewhere. Mail to a person about their own
 * account goes from the account sender; an owner notice passes the
 * notifications sender, as the worker's do.
 */
export function buildAccountEmail(input: {
  to: string;
  kind: AccountMailKind;
  locale: MailLocale;
  path: string;
  url?: string | undefined;
  from?: string | undefined;
  values?: Record<string, string>;
}): SystemMailMessage {
  return {
    from: input.from ?? accountEmailFrom() ?? "",
    to: input.to,
    ...buildAccountMail({
      kind: input.kind,
      locale: input.locale,
      url: input.url ?? `${appBaseUrl()}${input.path}`,
      ...(input.values ? { values: input.values } : {}),
    }),
    kind: input.kind,
  };
}

/** Exported for tests. Onboarding only: the first two steps and the docs. */
export function buildWelcomeEmail(input: {
  to: string;
  name: string;
  locale: MailLocale;
}): SystemMailMessage {
  return buildAccountEmail({
    to: input.to,
    kind: "welcome",
    locale: input.locale,
    path: "/domains",
    values: { name: input.name, docsUrl: DOCS_URL },
  });
}

/** Exported for tests. The button starts a new reset, which signs out whoever changed it. */
export function buildPasswordChangedEmail(input: {
  to: string;
  locale: MailLocale;
}): SystemMailMessage {
  return buildAccountEmail({
    to: input.to,
    kind: "password_changed",
    locale: input.locale,
    path: "/forgot-password",
    values: { email: input.to },
  });
}

/** Exported for tests. `team` is the team's name, or every team when the grant was for all. */
export function buildMcpConnectedEmail(input: {
  to: string;
  app: string;
  team: string | "*";
  scopes: string[];
  locale: MailLocale;
}): SystemMailMessage {
  const team =
    input.team === "*"
      ? accountMailPhrase({ locale: input.locale, kind: "mcp.connected", key: "allTeams" })
      : input.team;
  return buildAccountEmail({
    to: input.to,
    kind: "mcp.connected",
    locale: input.locale,
    path: "/settings/connected-apps",
    values: { app: input.app, team, scopes: input.scopes.join(", ") },
  });
}

/**
 * A mail about the account itself, sent without holding the request: the
 * endpoint's answer must not depend on the send, and a failure is logged
 * rather than surfaced — the account state it reports on already exists.
 */
export function sendAccountMail(
  message: SystemMailMessage,
  deps: SystemMailDeps = defaultSystemMailDeps,
): void {
  void deps.send(message).catch((error) => {
    console.error(`${message.kind} email failed to send`, error);
  });
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
      locale: localeFromHeaders(request?.headers),
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
      locale: localeFromHeaders(request?.headers),
    });
    void deps.send(message).catch((error) => {
      console.error("Verification email failed to send", error);
    });
  } catch (error) {
    console.error("Verification email skipped", error);
  }
}
