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
              <span
                style={{
                  flex: 1,
                  width: 1,
                  marginTop: 6,
                  // Softens the join at each number instead of butting into it.
                  background:
                    "linear-gradient(to bottom, transparent, var(--ms-line) 22%, var(--ms-line) 78%, transparent)",
                }}
              />
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

/** Left rail of one step row on the second screen: the step number (plus a ✓
 * when done) above the connector line. */
export function MarkerRail({
  marker,
  color,
  line = true,
  done = false,
  fadeTop = false,
  fadeBottom = false,
}: {
  marker: string;
  color: string;
  line?: boolean;
  /** Completed step: keeps the number and appends a check to its right. */
  done?: boolean;
  /** First step: a short line fades in above the marker (no layout shift). */
  fadeTop?: boolean;
  /** Last step: a short line fades out below the marker instead of a hard stop. */
  fadeBottom?: boolean;
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
      <span
        className="ms-mono"
        style={{ position: "relative", fontSize: 11, color, whiteSpace: "nowrap" }}
      >
        {fadeTop ? (
          <span
            style={{
              position: "absolute",
              left: "50%",
              bottom: "calc(100% + 6px)",
              transform: "translateX(-50%)",
              width: 1,
              height: 40,
              background: "linear-gradient(to bottom, transparent, var(--ms-line))",
            }}
          />
        ) : null}
        {marker}
        {done ? (
          // Absolutely positioned so the ✓ never shifts the number off the
          // rail's vertical centerline shared with the other step markers.
          <span
            style={{
              position: "absolute",
              left: "100%",
              top: "50%",
              transform: "translateY(-50%)",
              paddingLeft: 4,
            }}
          >
            ✓
          </span>
        ) : null}
      </span>
      {fadeBottom ? (
        <span
          style={{
            width: 1,
            height: 56,
            marginTop: 6,
            background: "linear-gradient(to bottom, var(--ms-line), transparent)",
          }}
        />
      ) : line ? (
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
