import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ConsoleShell } from "@/components/console/console-shell";
import { ToastHost } from "@/components/toast";
import { consoleOperator } from "@/server/console-gate";

/**
 * The operator console. Not linked from the app: on cloud it is reached by
 * typing the URL, on self-host from the Settings → SES card. Anyone but the
 * instance operator gets the same 404 a route that does not exist would.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const operator = await consoleOperator(await headers());
  if (!operator) notFound();
  return (
    <ConsoleShell userEmail={operator.email}>
      <main className="ms-main" style={{ flex: 1, minWidth: 0, padding: "32px 40px" }}>
        <div style={{ maxWidth: 1360, margin: "0 auto" }}>{children}</div>
      </main>
      <ToastHost />
    </ConsoleShell>
  );
}
