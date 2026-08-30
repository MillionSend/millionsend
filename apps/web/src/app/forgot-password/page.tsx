import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ForgotPasswordForm } from "@/components/auth/recovery-forms";
import { hasSession } from "@/server/auth";
import { passwordRecoveryEnabled, RESET_TOKEN_TTL_MINUTES } from "@/server/system-mail";

// Gated like the login screen's link: an instance that cannot deliver the
// reset email has no recovery flow to offer (the endpoint 400s there too).
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string | string[] }>;
}) {
  if (!passwordRecoveryEnabled()) redirect("/login");
  // An authenticated visitor has no business here; reset-password stays
  // reachable while signed in, since its token flow is legitimate either way.
  if (await hasSession()) redirect("/");
  // The login link carries the address already typed; it only seeds the
  // input, so a cap is the only validation needed here.
  const raw = (await searchParams).email;
  const initialEmail = typeof raw === "string" ? raw.trim().slice(0, 254) : "";
  return <ForgotPasswordForm minutes={RESET_TOKEN_TTL_MINUTES} initialEmail={initialEmail} />;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("forgot.title") };
}
