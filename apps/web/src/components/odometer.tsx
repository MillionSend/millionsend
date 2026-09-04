"use client";

import { useEffect, useId, useRef, useState } from "react";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/* Vertical-only blur levels (stdDeviation "0 N"), one per digit of travel:
   isotropic blur bleeds past the column's clip box and leaves hard side edges. */
const BLUR_LEVELS = [1, 2, 3.5, 5, 7];
/* Keep in step with --ms-dur-digit (tokens/motion.css). */
const DIGIT_MS = 400;
const STAGGER_MS = 45;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * CSS odometer over .ms-odometer (components.css): each digit is a 1em
 * column whose 0–9 strip slides to the target digit after mount, rolling
 * the number up from zero on load and wearing a motion blur scaled to how
 * far it travels — the LP hero's mechanic. prefers-reduced-motion zeroes
 * the transition in CSS and skips the blur, so it degrades to a plain
 * number. The last digit is steel — the view's single lit element
 * (DESIGN.md rule 1) — but only once the roll has landed: like the LP hero
 * lighting its cell after the climb, a digit still in motion wears the
 * same bone as the rest, and the steel fades in over the base duration.
 */
export function Odometer({ formatted }: { formatted: string }) {
  const [armed, setArmed] = useState(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setArmed(true);
    if (reducedMotion()) {
      setSettled(true);
      return;
    }
    const digits = formatted.replace(/\D/g, "").length;
    const landed = window.setTimeout(
      () => setSettled(true),
      Math.max(0, digits - 1) * STAGGER_MS + DIGIT_MS,
    );
    return () => window.clearTimeout(landed);
  }, [formatted]);
  // useId carries punctuation React reserves; url(#…) wants a plain token.
  const filterId = useId().replace(/\W/g, "");

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
        return (
          <Digit
            key={`d${cell.place}`}
            digit={armed ? Number(cell.ch) : 0}
            delayMs={digitPosition++ * STAGGER_MS}
            filterId={filterId}
            lit={settled && cell === lastDigit}
          />
        );
      })}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {BLUR_LEVELS.map((n, i) => (
            <filter
              key={n}
              id={`${filterId}vb${i + 1}`}
              x="-20%"
              y="-150%"
              width="140%"
              height="400%"
            >
              <feGaussianBlur stdDeviation={`0 ${n}`} />
            </filter>
          ))}
        </defs>
      </svg>
    </span>
  );
}

/** One column: the strip slides to `digit`, blurred for the roll's duration. */
function Digit({
  digit,
  delayMs,
  filterId,
  lit,
}: {
  digit: number;
  delayMs: number;
  filterId: string;
  lit: boolean;
}) {
  const shown = useRef(0);
  const [blur, setBlur] = useState(0);

  useEffect(() => {
    const travel = Math.abs(digit - shown.current);
    shown.current = digit;
    if (travel === 0 || reducedMotion()) {
      setBlur(0);
      return;
    }
    const level = Math.min(BLUR_LEVELS.length, travel);
    const on = window.setTimeout(() => setBlur(level), delayMs);
    const off = window.setTimeout(() => setBlur(0), delayMs + DIGIT_MS);
    return () => {
      window.clearTimeout(on);
      window.clearTimeout(off);
    };
  }, [digit, delayMs]);

  return (
    <span className="ms-odo-col" aria-hidden style={lit ? { color: "var(--ms-steel)" } : undefined}>
      <span
        className="ms-odo-strip"
        style={
          {
            transform: `translateY(-${digit}em)`,
            "--odo-d": `${delayMs}ms`,
            ...(blur ? { filter: `url(#${filterId}vb${blur})` } : {}),
          } as React.CSSProperties
        }
      >
        {DIGITS.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </span>
    </span>
  );
}
