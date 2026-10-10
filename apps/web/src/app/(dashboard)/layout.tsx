import { getDb } from "@millionsend/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfirmDialogHost } from "@/components/confirm-dialog";
import { DeliverabilityBanner } from "@/components/deliverability-banner";
import { EventsHealthBanner } from "@/components/events-health-banner";
import { SupportViewBanner } from "@/components/support-view-banner";
import { TeamStandingBanner } from "@/components/team-standing-banner";
import { ToastHost } from "@/components/toast";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";
import { resolveSupportView, SUPPORT_VIEW_COOKIE } from "@/server/support-view";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const db = getDb();
  const cookieStore = await cookies();
  // A live support view stands in for the membership: the shell shows the
  // viewed team under the banner, and the tRPC context resolves the same way.
  const view = await resolveSupportView(
    db,
    session.user.id,
    cookieStore.get(SUPPORT_VIEW_COOKIE)?.value,
  );
  const membership = view
    ? null
    : await getActiveMembership(db, session.user.id, cookieStore.get(ACTIVE_TEAM_COOKIE)?.value);
  const team = view ?? membership;
  if (!team) redirect("/onboarding");

  return (
    <AppShell
      teamName={team.teamName}
      teamLogoUrl={team.logoUrl}
      userEmail={session.user.email}
      banner={
        view ? (
          <SupportViewBanner
            grantId={view.grantId}
            teamId={view.teamId}
            teamName={view.teamName}
            expiresAt={view.expiresAt}
          />
        ) : null
      }
    >
      {/* Canvas main-block padding: 32px 40px (DESIGN.md Layout); 16px below 900px. */}
      <main className="ms-main" style={{ flex: 1, minWidth: 0, padding: "32px 40px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <TeamStandingBanner />
          <EventsHealthBanner />
          <DeliverabilityBanner />
          {children}
        </div>
      </main>
      <ConfirmDialogHost />
      {/* The dashboard raises toasts too (a refused mutation under a support
          view, the Support access card); without a host they are dropped. */}
      <ToastHost />
    </AppShell>
  );
}
