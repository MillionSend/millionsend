import { AuthForm } from "@/components/auth/auth-form";
import { enabledSocialProviders } from "@/server/auth";

// Server component so the env-derived social-provider flags reach the client
// form as props; the form itself keeps the better-auth client mechanism.
// ALLOW_SIGNUP stays enforced server-side by the better-auth user.create hook.
export default function SignupPage() {
  return <AuthForm mode="signup" providers={enabledSocialProviders()} />;
}
