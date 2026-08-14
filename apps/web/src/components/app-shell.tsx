import { CommandPalette } from "@/components/command-palette";
import { Sidebar } from "@/components/sidebar";

/**
 * Shared app chrome — sidebar plus the ⌘K palette — around a page's own
 * <main>. Every signed-in-with-a-team screen must render inside this so the
 * palette is never dead on a chrome-bearing route.
 */
export function AppShell({
  teamName,
  userEmail,
  children,
}: {
  teamName: string;
  userEmail: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar teamName={teamName} userEmail={userEmail} />
      <CommandPalette />
      {children}
    </div>
  );
}
