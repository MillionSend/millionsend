import type { Metadata } from "next";
import { headers } from "next/headers";
import styles from "@/components/auth/auth.module.css";
import { AuthScreen } from "@/components/auth/auth-screen";
import { localeFromHeaders } from "@/server/locale";
import en from "../../../messages/en/updates.json";
import ptBR from "../../../messages/pt-BR/updates.json";

export const metadata: Metadata = { robots: { index: false, follow: false } };

const MESSAGES = { en, "pt-BR": ptBR } as const;

/**
 * Public page: subscribe to product updates. A plain form, so it works from
 * the docs' link and the wizard's fallback alike; the endpoint answers with
 * a redirect back here.
 */
export default async function UpdatesPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const [query, headerList] = await Promise.all([searchParams, headers()]);
  const m = MESSAGES[localeFromHeaders(headerList)].page;
  return (
    <AuthScreen title={m.title}>
      {query.sent ? (
        <p className={styles.notice} aria-live="polite">
          {m.sent}
        </p>
      ) : (
        <>
          <p className={styles.subline}>{m.intro}</p>
          <form method="post" action="/api/updates/subscribe" className={styles.form}>
            <div className={`ms-field ${styles.field}`}>
              <label htmlFor="email">{m.email}</label>
              <input
                id="email"
                name="email"
                type="email"
                className={`ms-input ${styles.control}`}
                autoComplete="email"
                placeholder={m.emailPlaceholder}
                required
                maxLength={254}
              />
            </div>
            {query.error ? (
              <p className={styles.error}>{query.error === "rate" ? m.tryLater : m.invalidEmail}</p>
            ) : null}
            <button type="submit" className={`ms-btn ms-btn-primary ${styles.button}`}>
              {m.submit}
            </button>
          </form>
        </>
      )}
    </AuthScreen>
  );
}
