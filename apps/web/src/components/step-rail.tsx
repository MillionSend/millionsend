import type React from "react";

export interface RailStep {
  /** Stable identity when the rows can change; the position otherwise. */
  key?: string | number | undefined;
  when: React.ReactNode;
  what: React.ReactNode;
  sub?: React.ReactNode | undefined;
  /** "done" dims a day already out; "now" fills its dot. */
  state?: "done" | "now" | undefined;
  /** How much of the row has gone out, 0 to 1, drawn as a thin meter under it. */
  progress?: number | undefined;
}

/** The day-by-day rail (.ms-steps) of the send dialog, the broadcast page and the domain warm-up. */
export function StepRail({
  steps,
  label,
  compact = false,
}: {
  steps: readonly RailStep[];
  label: string;
  /** The list tooltip's cut: counts only, no meter and no second line. */
  compact?: boolean;
}) {
  return (
    <ol className={compact ? "ms-steps compact" : "ms-steps"} aria-label={label}>
      {steps.map((step, i) => (
        <li key={step.key ?? i} className={step.state}>
          <span className="when">{step.when}</span>
          <span className="what">
            {step.what}
            {!compact && step.progress !== undefined ? (
              <span className="bar" aria-hidden="true">
                <b style={{ width: `${Math.min(100, Math.max(0, step.progress * 100))}%` }} />
              </span>
            ) : null}
            {!compact && step.sub ? <small>{step.sub}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
