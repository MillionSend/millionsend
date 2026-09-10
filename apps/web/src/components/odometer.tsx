"use client";

import { useEffect, useId, useRef, useState } from "react";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/* Vertical-only blur levels (stdDeviation "0 N"), one per digit of travel:
   isotropic blur bleeds past the column's clip box and leaves hard side edges. */
const BLUR_LEVELS = [1, 2, 3.5, 5, 7];
/* Keep in step with --ms-dur-digit (tokens/motion.css). */
const DIGIT_MS = 400;
const STAGGER_MS = 45;
/* Allowance for the two paint frames the roll waits for before it starts. */
const FRAME_MS = 17;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/* Where the strip is right now, in em: mid-transition the computed transform
   carries the animated value, so a roll interrupted midway reads its true
   starting point. */
const positionEm = (el: HTMLElement) => {
  const cs = getComputedStyle(el);
  const m = cs.transform.match(/-?[\d.]+/g);
  return m ? -Number(m[5]) / Number.parseFloat(cs.fontSize) : 0;
};

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
    if (reducedMotion()) {
      setArmed(true);
      setSettled(true);
      return;
    }
    // The zeroed strips must reach the screen once before the target is
    // set, or the transition has no start frame: the digits appear already
    // landed while the blur still plays over them. Two frames guarantee a
    // paint in between.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setArmed(true));
    });
    const digits = formatted.replace(/\D/g, "").length;
    const landed = window.setTimeout(
      () => setSettled(true),
      Math.max(0, digits - 1) * STAGGER_MS + DIGIT_MS + 2 * FRAME_MS,
    );
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(landed);
    };
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

/**
 * One column: the strip slides to `digit`, blurred while it moves. The blur
 * is sized from the distance the strip still has to cover, read off its
 * current position: a target that reverses mid-roll travels less than the
 * digits suggest, and CSS shortens the reversed transition to match. The
 * blur follows the transition's own start, end and cancel events, so it
 * never outlives the motion.
 */
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
  const strip = useRef<HTMLSpanElement>(null);
  const level = useRef(0);
  const [blur, setBlur] = useState(0);

  useEffect(() => {
    if (!strip.current || reducedMotion()) return;
    const travel = Math.abs(digit - positionEm(strip.current));
    level.current = Math.min(BLUR_LEVELS.length, Math.round(travel));
  }, [digit]);

  // React's synthetic transitionstart and transitioncancel events carry no
  // propertyName (only transitionend does); the native event always has it.
  const onTransform = (e: React.TransitionEvent, moving: boolean) => {
    if (e.nativeEvent.propertyName === "transform") setBlur(moving ? level.current : 0);
  };

  return (
    <span className="ms-odo-col" aria-hidden style={lit ? { color: "var(--ms-steel)" } : undefined}>
      <span
        ref={strip}
        className="ms-odo-strip"
        onTransitionStart={(e) => onTransform(e, true)}
        onTransitionEnd={(e) => onTransform(e, false)}
        onTransitionCancel={(e) => onTransform(e, false)}
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
