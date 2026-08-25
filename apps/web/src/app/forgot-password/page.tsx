import { redirect } from "next/navigation";
import { ForgotPasswordForm } from "@/components/auth/recovery-forms";
import { passwordRecoveryEnabled, RESET_TOKEN_TTL_MINUTES } from "@/server/system-mail";

// Gated like the login screen's link: an instance that cannot deliver the
// reset email has no recovery flow to offer (the endpoint 400s there too).
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string | string[] }>;
}) {
  if (!passwordRecoveryEnabled()) redirect("/login");
  // The login link carries the address already typed; it only seeds the
  // input, so a cap is the only validation needed here.
  const raw = (await searchParams).email;
  const initialEmail = typeof raw === "string" ? raw.trim().slice(0, 254) : "";
  return <ForgotPasswordForm minutes={RESET_TOKEN_TTL_MINUTES} initialEmail={initialEmail} />;
}
