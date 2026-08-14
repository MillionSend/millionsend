"use client";

import { useEffect, useState } from "react";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * CSS odometer over .ms-odometer (components.css): each digit is a 1em
 * column whose 0–9 strip slides to the target digit after mount, rolling
 * the number up from zero on load. prefers-reduced-motion zeroes the
 * transition in CSS, so it degrades to a plain number. The last digit is
 * steel — the view's single lit element (DESIGN.md rule 1).
 */
export function Odometer({ formatted }: { formatted: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);

  // Cells keyed by place value (distance from the right), so a digit keeps
  // its column identity when the number grows a digit on the left.
  const chars = [...formatted];
  const cells = chars.map((ch, i) => ({ ch, place: chars.length - i }));
  const lastDigit = cells.find((cell) => cell.place === 1 && /\d/.test(cell.ch));
  let digitPosition = 0;

  return (
    <span className="ms-odometer" role="img" aria-label={formatted}>
      {cells.map((cell) => {
        if (!/\d/.test(cell.ch)) {
          return (
            <span key={`s${cell.place}`} aria-hidden>
              {cell.ch}
            </span>
          );
        }
        const delay = `${digitPosition++ * 45}ms`;
        return (
          <span
            key={`d${cell.place}`}
            className="ms-odo-col"
            aria-hidden
            style={cell === lastDigit ? { color: "var(--ms-steel)" } : undefined}
          >
            <span
              className="ms-odo-strip"
              style={
                {
                  transform: `translateY(-${armed ? Number(cell.ch) : 0}em)`,
                  "--odo-d": delay,
                } as React.CSSProperties
              }
            >
              {DIGITS.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
