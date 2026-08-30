import type { ReactNode } from "react";

/** Full-viewport stop for 404 / error boundaries: the counting-number
 *  treatment as hero, one serif sentence, one muted line, the app's buttons.
 *  Hook-free so both server (not-found) and client (error) routes can use it. */
export function StatusPage({
  code,
  title,
  body,
  actions,
}: {
  code: string;
  title: string;
  body: string;
  actions: ReactNode;
}) {
  return (
    <main className="ms-status">
      <div className="ms-digits ms-status-code">{code}</div>
      <h1 className="ms-status-title">{title}</h1>
      <p className="ms-status-body">{body}</p>
      <div className="ms-status-actions">{actions}</div>
    </main>
  );
}
