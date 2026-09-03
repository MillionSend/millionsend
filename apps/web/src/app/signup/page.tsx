import { env } from "@millionsend/config";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthForm } from "@/components/auth/auth-form";
import { enabledSocialProviders, hasSession } from "@/server/auth";

// Server component so the env-derived social-provider flags reach the client
// form as props; the form itself keeps the better-auth client mechanism.
// ALLOW_SIGNUP stays enforced server-side by the better-auth user.create hook.
export default async function SignupPage() {
  // An authenticated visitor has no business on the auth screens.
  if (await hasSession()) redirect("/");
  return (
    <AuthForm
      mode="signup"
      providers={enabledSocialProviders()}
      legal={{ termsUrl: env.TERMS_URL ?? null, privacyUrl: env.PRIVACY_URL ?? null }}
      turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? null}
    />
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("signup.submit"), robots: { index: true, follow: true } };
}
