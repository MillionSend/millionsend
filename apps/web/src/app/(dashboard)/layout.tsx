import { getDb } from "@millionsend/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CommandPalette } from "@/components/command-palette";
import { Sidebar } from "@/components/sidebar";
import { getAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const membership = await getActiveMembership(getDb(), session.user.id);
  if (!membership) redirect("/onboarding");

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar teamName={membership.teamName} userEmail={session.user.email} />
      <CommandPalette />
      <main style={{ flex: 1, minWidth: 0, padding: "48px 75px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>{children}</div>
      </main>
    </div>
  );
}
