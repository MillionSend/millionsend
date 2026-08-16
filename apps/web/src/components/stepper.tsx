"use client";

/**
 * The two-step wizard grammar shared by the add-domain flow and the broadcast
 * composer: a vertical number rail beside the card on desktop, per-row marker
 * rails on the second screen, and a labelled horizontal bar that replaces the
 * rail on narrow screens (the rail's wrapped numbers read as detached
 * otherwise — see the .ms-stepbar rules in components.css).
 */

/** Vertical rail for the first screen: the current number lit, the rest faint. */
export function StepRail({ current = 1, total = 2 }: { current?: number; total?: number }) {
  return (
    <div
      aria-hidden="true"
      className="ms-stepper-rail"
      style={{
        width: 30,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        alignSelf: "stretch",
      }}
    >
      {Array.from({ length: total }, (_, index) => {
        const num = index + 1;
        return (
          <span key={num} style={{ display: "contents" }}>
            {index > 0 ? (
              <span style={{ flex: 1, width: 1, background: "var(--ms-line)", marginTop: 6 }} />
            ) : null}
            <span
              className="ms-mono"
              style={{
                fontSize: 11,
                color: num === current ? "var(--ms-bone)" : "var(--ms-faint)",
                marginTop: index > 0 ? 6 : 0,
              }}
            >
              {`0${num}`}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** Left rail of one step row on the second screen: marker (✓ or number) above
 * the connector line. */
export function MarkerRail({
  marker,
  color,
  line = true,
}: {
  marker: string;
  color: string;
  line?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="ms-stepper-rail"
      style={{
        width: 30,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <span className="ms-mono" style={{ fontSize: 11, color }}>
        {marker}
      </span>
      {line ? (
        <span style={{ flex: 1, width: 1, background: "var(--ms-line)", marginTop: 6 }} />
      ) : null}
    </div>
  );
}

/**
 * Horizontal step indicator shown in place of the vertical rail on narrow
 * screens (≤899px). Labelled and connected so the steps stay legible as a
 * sequence; rendered as a real <ol> with aria-current for screen readers.
 */
export function MobileStepBar({ steps, active }: { steps: string[]; active: number }) {
  return (
    <ol className="ms-stepbar">
      {steps.map((label, index) => {
        const num = index + 1;
        const state = num < active ? "done" : num === active ? "current" : "upcoming";
        return (
          <li
            key={label}
            className={`ms-stepbar-step ${state}`}
            {...(num === active ? { "aria-current": "step" } : {})}
          >
            <span className="ms-stepbar-dot ms-mono">{num < active ? "✓" : `0${num}`}</span>
            <span className="ms-stepbar-text">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
