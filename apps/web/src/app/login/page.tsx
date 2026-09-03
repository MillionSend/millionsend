import { env } from "@millionsend/config";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthForm } from "@/components/auth/auth-form";
import { enabledSocialProviders, hasSession } from "@/server/auth";
import { passwordRecoveryEnabled } from "@/server/system-mail";

// Server component so the env-derived social-provider flags reach the client
// form as props; the form itself keeps the better-auth client mechanism.
export default async function LoginPage() {
  // An authenticated visitor has no business on the auth screens.
  if (await hasSession()) redirect("/");
  return (
    <AuthForm
      mode="login"
      providers={enabledSocialProviders()}
      legal={{ termsUrl: env.TERMS_URL ?? null, privacyUrl: env.PRIVACY_URL ?? null }}
      forgotPassword={passwordRecoveryEnabled()}
      turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? null}
    />
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("login.submit"), robots: { index: true, follow: true } };
}
