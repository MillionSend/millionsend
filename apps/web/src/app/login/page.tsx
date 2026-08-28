import { env } from "@millionsend/config";
import { redirect } from "next/navigation";
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
    />
  );
}
