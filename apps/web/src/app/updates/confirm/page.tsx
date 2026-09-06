import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import styles from "@/components/auth/auth.module.css";
import { AuthScreen } from "@/components/auth/auth-screen";
import { localeFromHeaders } from "@/server/locale";
import { readUpdatesLink } from "@/server/updates";
import en from "../../../../messages/en/updates.json";
import ptBR from "../../../../messages/pt-BR/updates.json";

export const metadata: Metadata = { robots: { index: false, follow: false } };

const MESSAGES = { en, "pt-BR": ptBR } as const;

/**
 * Where the confirmation link lands. Opening it commits to nothing — mail
 * gateways open links — so the page shows a button whose form post
 * (/api/updates/confirm) is the consent, then returns here with ?done=1.
 */
export default async function UpdatesConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; done?: string; error?: string }>;
}) {
  const [query, headerList] = await Promise.all([searchParams, headers()]);
  const m = MESSAGES[localeFromHeaders(headerList)].page;
  const token = typeof query.token === "string" ? query.token : "";
  const link = query.done || query.error ? null : token ? readUpdatesLink(token) : null;
  return (
    <AuthScreen title={m.title}>
      {query.done ? (
        <p className={styles.notice} aria-live="polite">
          {m.confirmed}
        </p>
      ) : link ? (
        <form method="post" action="/api/updates/confirm" className={styles.form}>
          <p className={styles.subline}>{m.confirmPrompt.replace("{email}", link.email)}</p>
          <input type="hidden" name="token" value={token} />
          <button type="submit" className={`ms-btn ms-btn-primary ${styles.button}`}>
            {m.confirmButton}
          </button>
        </form>
      ) : (
        <>
          <p className={styles.notice}>{m.invalid}</p>
          <p className={styles.subline}>
            <Link href="/updates">{m.submit}</Link>
          </p>
        </>
      )}
    </AuthScreen>
  );
}
