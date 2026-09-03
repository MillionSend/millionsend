import { getDb } from "@millionsend/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfirmDialogHost } from "@/components/confirm-dialog";
import { DeliverabilityBanner } from "@/components/deliverability-banner";
import { EventsHealthBanner } from "@/components/events-health-banner";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const membership = await getActiveMembership(
    getDb(),
    session.user.id,
    (await cookies()).get(ACTIVE_TEAM_COOKIE)?.value,
  );
  if (!membership) redirect("/onboarding");

  return (
    <AppShell
      teamName={membership.teamName}
      teamLogoUrl={membership.logoUrl}
      userEmail={session.user.email}
    >
      {/* Canvas main-block padding: 32px 40px (DESIGN.md Layout); 16px below 900px. */}
      <main className="ms-main" style={{ flex: 1, minWidth: 0, padding: "32px 40px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <EventsHealthBanner />
          <DeliverabilityBanner />
          {children}
        </div>
      </main>
      <ConfirmDialogHost />
    </AppShell>
  );
}
