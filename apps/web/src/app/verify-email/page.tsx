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
 * the address. No session comes with the link (the registrant, not
 * necessarily the address's owner, chose the password), so the page sends
 * a verified visitor to sign in for where sign-up was headed; an invalid or
 * expired link (Better Auth appends ?error=) reads why, and sign-in re-sends
 * one. A visitor who already has a session simply moves on.
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
