import { EMAIL_WORDMARK_URL, escapeHtml } from "@millionsend/core/html";
import en from "../../messages/en/onboarding-email.json";
import ptBR from "../../messages/pt-BR/onboarding-email.json";

const MESSAGES = { en, "pt-BR": ptBR } as const;
export const MAIL_LOCALES = ["en", "pt-BR"] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];

/**
 * The onboarding "Send email" body in the dashboard's locale: the first
 * email a team ever sends through the instance. Exported for tests;
 * interpolates and escapes, so strings stay in JSON.
 */
export function buildOnboardingEmail(input: {
  locale: MailLocale;
  team: string;
  dashboardUrl: string | null;
}): { subject: string; html: string; text: string } {
  const m = MESSAGES[input.locale];
  const footer = m.footer.replace("{team}", input.team);
  const button = input.dashboardUrl
    ? `<a href="${escapeHtml(input.dashboardUrl)}" style="display:inline-block;background:#18181b;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;padding:12px 20px">${escapeHtml(m.button)}</a>`
    : "";
  const html = `<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <img src="${EMAIL_WORDMARK_URL}" width="174" height="24" alt="MillionSend" style="display:block;height:24px;width:auto;margin:0 0 24px;border:0">
    <p style="font-size:22px;line-height:1.3;font-weight:700;color:#18181b;margin:0 0 12px;font-variant-numeric:tabular-nums">${escapeHtml(m.heading)}</p>
    <p style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 24px">${escapeHtml(m.body)}</p>
    ${button}
    <p style="font-size:13px;line-height:1.5;color:#52525b;margin:24px 0 0">${escapeHtml(footer)}</p>
  </div>
</div>`;
  const text = `${m.heading}\n\n${m.body}\n${input.dashboardUrl ? `\n${input.dashboardUrl}\n` : ""}\n${footer}\n`;
  return { subject: m.subject, html, text };
}
