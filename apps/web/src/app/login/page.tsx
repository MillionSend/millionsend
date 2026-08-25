import { env } from "@millionsend/config";
import { AuthForm } from "@/components/auth/auth-form";
import { enabledSocialProviders } from "@/server/auth";
import { passwordRecoveryEnabled } from "@/server/system-mail";

// Server component so the env-derived social-provider flags reach the client
// form as props; the form itself keeps the better-auth client mechanism.
export default function LoginPage() {
  return (
    <AuthForm
      mode="login"
      providers={enabledSocialProviders()}
      legal={{ termsUrl: env.TERMS_URL ?? null, privacyUrl: env.PRIVACY_URL ?? null }}
      forgotPassword={passwordRecoveryEnabled()}
    />
  );
}
