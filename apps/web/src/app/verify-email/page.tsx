import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import styles from "@/components/auth/auth.module.css";
import { AuthScreen } from "@/components/auth/auth-screen";
import { safeNextPath } from "@/lib/nav";
import { hasSession } from "@/server/auth";

/**
 * Where the emailed verification link lands once Better Auth has verified
 * the address and signed the visitor in: on to where sign-up was headed.
 * Without a session the link was invalid or expired (Better Auth appends
 * ?error=), or the verification succeeded but no session could be set —
 * either way sign-in is the next step, and it re-sends the link if needed.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null, "/onboarding");
  if (await hasSession()) redirect(next);
  const t = await getTranslations("auth.verify");
  return (
    <AuthScreen title={t("title")}>
      <p className={styles.notice}>{params.error ? t("failed") : t("verified")}</p>
      <p className={styles.subline}>
        <Link href={`/login?next=${encodeURIComponent(next)}`}>{t("signIn")}</Link>
      </p>
    </AuthScreen>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("verify.title") };
}
