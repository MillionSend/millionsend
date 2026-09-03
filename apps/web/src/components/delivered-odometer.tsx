"use client";

import { useEffect, useId, useRef } from "react";

const CELLS = 7;
/* First climb from zero, then each later tick. */
const CLIMB_MS = 2400;
const STEP_MS = 700;
/* Vertical-only blur levels (stdDeviation "0 N"): isotropic blur bleeds past
   the cell's clip box and leaves hard side edges. */
const BLUR_LEVELS = [1, 2, 3.5, 5, 7];
/* One wheel: 0..9 then 0 again so a 9 to 0 sweep never shows an empty slot. */
const WHEEL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The LP hero's odometer (millionsend-lp hero-odometer.tsx, same mechanics)
 * pointed at a live number: seven masked wheels climb from zero to `value`
 * as a lockstep cascade with a motion blur scaled to each wheel's speed, and
 * every later increase rolls on from where the wheels stand. The units cell
 * is lit steel once the count is live. Under reduced motion it renders the
 * value static.
 */
export function DeliveredOdometer({ value, locale }: { value: number; locale: string }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  // The number the wheels currently show (fractional mid-roll), so a new
  // target rolls on from here instead of restarting.
  const shown = useRef(0);
  // useId carries punctuation React reserves; url(#…) wants a plain token.
  const filterId = useId().replace(/\W/g, "");
  const sep = (1000).toLocaleString(locale).charAt(1);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const cells = [...root.querySelectorAll<HTMLElement>(".od-cell")].map((cell) => ({
      cell,
      strip: cell.firstElementChild as HTMLElement,
      last: -1,
      lvl: 0,
    }));
    const first = cells[0];
    const units = cells[cells.length - 1];
    if (!first || !units) return;

    let H = 16;
    const measure = () => {
      H = first.strip.firstElementChild?.getBoundingClientRect().height || 16;
    };
    measure();
    window.addEventListener("resize", measure);

    const set = (n: number, blur = false) => {
      let lower = 0;
      for (let i = cells.length - 1; i >= 0; i--) {
        const c = cells[i] as (typeof cells)[number];
        const scale = 10 ** (cells.length - 1 - i);
        const p = scale === 1 ? n % 10 : (Math.floor(n / scale) % 10) + Math.max(0, lower - 9);
        lower = p;
        c.strip.style.transform = `translateY(${-(p + 0.5) * H}px)`;
        if (blur) {
          let v = c.last < 0 ? 0 : Math.abs(p - c.last);
          if (v > 5) v = 10 - v;
          const b = Math.min(7, Math.max(0, v * H * 0.55 - 1.5));
          const lvl = b <= 0.4 ? 0 : b < 1.6 ? 1 : b < 2.8 ? 2 : b < 4.3 ? 3 : b < 6 ? 4 : 5;
          if (lvl !== c.lvl) {
            c.strip.style.filter = lvl ? `url(#${filterId}vb${lvl})` : "none";
            c.lvl = lvl;
          }
          c.last = p;
        }
      }
    };
    const target = Math.min(value, 10 ** CELLS - 1);
    const settle = () => {
      set(target, true);
      // The last moving frame can leave a wheel filtered; a settled wheel is sharp.
      for (const c of cells) {
        c.strip.style.filter = "none";
        c.lvl = 0;
      }
      shown.current = target;
      units.cell.classList.toggle("lit", target > 0);
      root.setAttribute("aria-label", target.toLocaleString(locale));
    };
    const from = shown.current;
    if (from === target || reducedMotion()) {
      settle();
      return () => window.removeEventListener("resize", measure);
    }

    // The first climb scales with how many wheels move: a single digit given
    // the full hero duration arrives early and then creeps, with the steel
    // only landing at the end.
    const D = from === 0 ? Math.min(CLIMB_MS, 500 + 250 * String(target).length) : STEP_MS;
    let t0: number | null = null;
    let raf = 0;
    const frame = (ts: number) => {
      if (t0 === null) t0 = ts;
      const p = Math.min(1, (ts - t0) / D);
      const at = from + (1 - (1 - p) ** 5) * (target - from);
      shown.current = at;
      set(at, true);
      if (p < 1) raf = requestAnimationFrame(frame);
      else settle();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [value, locale, filterId]);

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (i > 0 && (CELLS - i) % 3 === 0) {
      cells.push(
        <span key={`c${i}`} className="od-comma" aria-hidden="true">
          {sep}
        </span>,
      );
    }
    cells.push(
      <span key={`d${i}`} className="od-cell" aria-hidden="true">
        {/* Pre-hydration position of digit 0 (the strip's first span, centred). */}
        <span className="od-strip" style={{ transform: "translateY(-0.5em)" }}>
          {WHEEL.map((n) => (
            <span key={n}>{n % 10}</span>
          ))}
        </span>
      </span>,
    );
  }

  return (
    <>
      <span ref={rootRef} className="od" role="img" aria-label={value.toLocaleString(locale)}>
        {cells}
      </span>
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
    </>
  );
}
