"use client";

import { useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * One filter/search/range value mirrored into the URL query string so list
 * state survives refresh and can be shared as a link. Writes go through
 * history.replaceState — Next's shallow-routing path — so typing in a search
 * box never triggers a server round-trip or a history entry per keystroke.
 * The default value is represented by the param's absence; values arriving
 * from the URL are untrusted, so callers with enum-like params must validate
 * and fall back to the default.
 */
export function useUrlState(name: string, defaultValue = ""): [string, (value: string) => void] {
  const params = useSearchParams();
  const value = params.get(name) ?? defaultValue;
  const set = useCallback(
    (next: string) => {
      const query = new URLSearchParams(window.location.search);
      if (next === defaultValue || next === "") query.delete(name);
      else query.set(name, next);
      const qs = query.toString();
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    },
    [name, defaultValue],
  );
  return [value, set];
}
