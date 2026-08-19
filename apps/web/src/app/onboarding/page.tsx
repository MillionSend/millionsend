import { env } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { apiBaseUrl } from "@/lib/api-base-url";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";
import { uploadsEnabled } from "@/server/storage";
import { OnboardingForm } from "./onboarding-form";
import { OnboardingSteps } from "./onboarding-steps";

export default async function OnboardingPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const membership = await getActiveMembership(
    getDb(),
    session.user.id,
    (await cookies()).get(ACTIVE_TEAM_COOKIE)?.value,
  );
  if (!membership) return <OnboardingForm logoUploadsEnabled={uploadsEnabled()} />;
  // Post-team onboarding lives in the app chrome (canvas Row 2): the sidebar
  // itself is the skip affordance — every nav link leads to the dashboard.
  return (
    <AppShell
      teamName={membership.teamName}
      teamLogoUrl={membership.logoUrl}
      userEmail={session.user.email}
    >
      <main className="ms-main" style={{ flex: 1, minWidth: 0, padding: "34px 40px" }}>
        <OnboardingSteps
          userEmail={session.user.email}
          accountCreatedAt={new Date(session.user.createdAt).toISOString()}
          apiUrl={apiBaseUrl()}
          showInstanceHint={!env.IS_CLOUD}
        />
      </main>
    </AppShell>
  );
}
