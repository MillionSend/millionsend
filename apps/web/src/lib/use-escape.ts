"use client";

import { useEffect, useEffectEvent } from "react";
import { escapeTaken } from "./keyboard";

/**
 * Runs `onEscape` on an Esc nothing else takes: not one typed in a field or
 * meant for an open layer (escapeTaken), and not one a handler already used
 * (preventDefault, or stopPropagation before it reached window). Layers are
 * read as the key goes down: by the time it bubbles to window, a tooltip or
 * menu that closed on it may already be gone from the page.
 */
export function useEscape(onEscape: () => void) {
  const fire = useEffectEvent(onEscape);
  useEffect(() => {
    let taken = false;
    const onCapture = (event: KeyboardEvent) => {
      taken = event.key === "Escape" && escapeTaken(event.target);
    };
    const onBubble = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !taken && !event.defaultPrevented) fire();
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble);
    };
  }, []);
}
