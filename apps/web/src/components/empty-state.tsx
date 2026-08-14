import type { ReactNode } from "react";
import { type EmptyStateArea, EmptyStateGlyph } from "@/components/empty-state-tiles";

/**
 * Centered empty state: floating app-icon tile with the area's glyph,
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
        <div className="ms-empty-tile">
          <EmptyStateGlyph area={area} />
        </div>
      </div>
      <p className="ms-empty-headline">{headline}</p>
      {body ? <p className="ms-empty-body">{body}</p> : null}
      {cta ? <div className="ms-empty-cta">{cta}</div> : null}
    </div>
  );
}
