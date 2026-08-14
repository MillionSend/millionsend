import type { ReactNode } from "react";

/** Keys match the tile renders in public/empty-states/<area>.webp. */
export type EmptyStateArea =
  | "emails"
  | "broadcasts"
  | "templates"
  | "audience"
  | "metrics"
  | "domains"
  | "logs"
  | "api-keys"
  | "webhooks";

/**
 * Centered empty state: floating 3D app-icon tile render for the area,
 * "No X yet." headline, one-line explainer, optional CTA. Layout, depth
 * and motion live in components.css (.ms-empty*).
 */
export function EmptyState({
  area,
  headline,
  body,
  cta,
}: {
  area: EmptyStateArea;
  headline: string;
  body?: string;
  cta?: ReactNode;
}) {
  return (
    <div className="ms-card ms-empty">
      <div className="ms-empty-scene" aria-hidden="true">
        <img
          className="ms-empty-tile"
          src={`/empty-states/${area}.webp`}
          alt=""
          width={96}
          height={96}
        />
      </div>
      <p className="ms-empty-headline">{headline}</p>
      {body ? <p className="ms-empty-body">{body}</p> : null}
      {cta ? <div className="ms-empty-cta">{cta}</div> : null}
    </div>
  );
}
