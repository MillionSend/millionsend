import { env } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import { createSesSendClient, type SimpleEmail, sendSimpleEmail } from "@millionsend/ses";
import { and, eq, gt, like, ne } from "drizzle-orm";
import { escapeHtml } from "@/lib/html";
import en from "../../messages/en/reset-email.json";
import ptBR from "../../messages/pt-BR/reset-email.json";

export const RESET_TOKEN_TTL_MINUTES = 30;

/** Repeat reset requests for the same account inside this window send nothing. */
export const RESET_EMAIL_THROTTLE_MS = 2 * 60 * 1000;

const MESSAGES = { en, "pt-BR": ptBR } as const;
type MailLocale = keyof typeof MESSAGES;

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
 * Dashboard-surface locale: the NEXT_LOCALE cookie the app sets, then
 * Accept-Language. Anything that isn't Portuguese reads English — the email
 * locales mirror the dashboard's launch locales.
 */
function pickLocale(request: Request | undefined): MailLocale {
  const cookie = request?.headers.get("cookie")?.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1];
  const acceptLanguage = request?.headers.get("accept-language") ?? "";
  for (const candidate of [cookie, ...acceptLanguage.split(",")]) {
    const tag = candidate?.trim().toLowerCase();
    if (!tag) continue;
    if (tag.startsWith("pt")) return "pt-BR";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

/**
 * Hosted by the MillionSend product site rather than the instance: most
 * self-hosted deployments sit on private or loopback hosts that recipients'
 * mail clients cannot fetch from. The alt text covers image-blocking clients.
 */
const EMAIL_WORDMARK_URL = "https://millionsend.com/email/wordmark.png";

const MUTED = 'style="font-size:13px;line-height:1.5;color:#52525b;margin:24px 0 0"';

/** Exported for tests; interpolates and escapes, so strings stay in JSON. */
export function buildResetEmail(input: {
  to: string;
  name: string;
  url: string;
  locale: MailLocale;
}): SimpleEmail {
  const m = MESSAGES[input.locale];
  const greeting = m.greeting.replace("{name}", input.name);
  const expiry = m.expiry.replace("{minutes}", String(RESET_TOKEN_TTL_MINUTES));
  const url = escapeHtml(input.url);
  const html = `<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <img src="${EMAIL_WORDMARK_URL}" width="174" height="24" alt="MillionSend" style="display:block;height:24px;width:auto;margin:0 0 24px;border:0">
    <p style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 12px">${escapeHtml(greeting)}</p>
    <p style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 24px">${m.body}</p>
    <a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;padding:12px 20px">${m.button}</a>
    <p ${MUTED}>${m.linkFallback}<br><a href="${url}" style="color:#18181b;word-break:break-all">${url}</a></p>
    <p ${MUTED}>${expiry} ${m.ignore}</p>
  </div>
</div>`;
  const text = `${greeting}\n\n${m.body}\n\n${input.url}\n\n${expiry} ${m.ignore}\n`;
  return { from: env.AUTH_EMAIL_FROM ?? "", to: input.to, subject: m.subject, html, text };
}

/** SES seam so tests capture sends instead of stubbing the AWS SDK. */
export interface SystemMailDeps {
  send(message: SimpleEmail): Promise<void>;
}

const defaultDeps: SystemMailDeps = {
  // Client per send, like defaultSesDeps in routers/system.ts: resets are
  // rare, so there is nothing worth caching.
  send: (message) =>
    sendSimpleEmail(
      createSesSendClient({
        region: env.AWS_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      }),
      message,
    ),
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
  deps: SystemMailDeps = defaultDeps,
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
      locale: pickLocale(request),
    });
    void deps.send(message).catch((error) => {
      console.error("Password reset email failed to send", error);
    });
  } catch (error) {
    console.error("Password reset email skipped", error);
  }
}
