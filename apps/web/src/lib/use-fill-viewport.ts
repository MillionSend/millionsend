"use client";

import { type RefObject, useLayoutEffect } from "react";

/**
 * Keeps `--ms-fill-top` on the element at its distance from the top of the
 * document, so CSS can size it to the viewport under it:
 * calc(100dvh - var(--ms-fill-top)). The body's resizes cover what moves it
 * (the window, content above it growing or wrapping, a banner); the parent's
 * cover content above it shrinking, which a body held at 100vh never reports.
 */
export function useFillViewport(ref: RefObject<HTMLElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!on || !element) return;
    const measure = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.setProperty("--ms-fill-top", `${Math.round(top)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [ref, on]);
}
