import { ResetPasswordForm } from "@/components/auth/recovery-forms";

// The emailed link hits better-auth's GET /api/auth/reset-password/:token,
// which validates the token and redirects here with ?token= on success or
// ?error=INVALID_TOKEN otherwise; both invalid shapes collapse to token=null.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const query = await searchParams;
  return <ResetPasswordForm token={query.error ? null : (query.token ?? null)} />;
}
