import { env } from "@millionsend/config";

/**
 * Whether the SMTP relay is offered to the people reading this dashboard.
 *
 * Self-host always offers it: the reader owns the deployment, so the tab
 * renders and explains what is still missing (no keypair, insecure auth) and
 * they can act on it. On cloud the reader is a customer who can change
 * nothing, so an unexposed relay is absent rather than broken — the tab, the
 * page and the query all disappear together.
 *
 * Cloud needs both halves: without a STARTTLS keypair the relay refuses to
 * start at all, and without SMTP_PUBLIC_HOST the connection details would
 * name the dashboard's own hostname, which fronts HTTP and never answers on
 * the relay port.
 */
export function smtpRelayOffered(): boolean {
  if (!env.IS_CLOUD) return true;
  return Boolean(env.SMTP_TLS_CERT_PATH && env.SMTP_TLS_KEY_PATH && env.SMTP_PUBLIC_HOST);
}
