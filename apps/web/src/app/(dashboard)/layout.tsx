import { getDb } from "@millionsend/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const membership = await getActiveMembership(getDb(), session.user.id);
  if (!membership) redirect("/onboarding");

  return (
    <AppShell teamName={membership.teamName} userEmail={session.user.email}>
      <main style={{ flex: 1, minWidth: 0, padding: "48px 75px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>{children}</div>
      </main>
    </AppShell>
  );
}
