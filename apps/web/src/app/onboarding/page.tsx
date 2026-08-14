import { env } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { getAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";
import { OnboardingForm } from "./onboarding-form";
import { OnboardingSteps } from "./onboarding-steps";

// ponytail: assumes the API listens on port 3001 of the dashboard host (the
// docker-compose default). Add a dedicated public-API-URL env when a reverse
// proxy serves the API elsewhere.
function apiBaseUrl(): string {
  const url = new URL(env.APP_BASE_URL ?? "http://localhost:3000");
  return `${url.protocol}//${url.hostname}:3001`;
}

export default async function OnboardingPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const membership = await getActiveMembership(getDb(), session.user.id);
  if (!membership) return <OnboardingForm />;
  // Post-team onboarding lives in the app chrome (canvas Row 2): the sidebar
  // itself is the skip affordance — every nav link leads to the dashboard.
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar teamName={membership.teamName} userEmail={session.user.email} />
      <main style={{ flex: 1, minWidth: 0, padding: "34px 40px" }}>
        <OnboardingSteps
          userEmail={session.user.email}
          accountCreatedAt={new Date(session.user.createdAt).toISOString()}
          apiUrl={apiBaseUrl()}
        />
      </main>
    </div>
  );
}
