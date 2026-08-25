import { redirect } from "next/navigation";
import { ForgotPasswordForm } from "@/components/auth/recovery-forms";
import { passwordRecoveryEnabled, RESET_TOKEN_TTL_MINUTES } from "@/server/system-mail";

// Gated like the login screen's link: an instance that cannot deliver the
// reset email has no recovery flow to offer (the endpoint 400s there too).
export default function ForgotPasswordPage() {
  if (!passwordRecoveryEnabled()) redirect("/login");
  return <ForgotPasswordForm minutes={RESET_TOKEN_TTL_MINUTES} />;
}
