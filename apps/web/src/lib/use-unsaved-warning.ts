"use client";

import { useEffect, useRef } from "react";

/* Programmatic navigations (router.push from a component, e.g. the From
   field's add-domain shortcut) never touch an anchor or the history stack the
   guards below watch — so guarded pages register here, and any shared
   component about to router.push calls confirmUnsavedNavigation() first.
   Editor pages render one at a time, so a single slot suffices. */
let activeGuard: { isDirty: () => boolean; message: () => string } | null = null;

/** True when navigation may proceed: no dirty guard, or the user confirmed. */
export function confirmUnsavedNavigation(): boolean {
  if (!activeGuard?.isDirty()) return true;
  return window.confirm(activeGuard.message());
}

/**
 * Guards against losing unsaved changes on every navigation kind:
 *
 * - tab close / reload / external URLs — the native beforeunload prompt;
 * - in-app <Link>/<a> clicks (sidebar included) — a capture-phase click
 *   interceptor showing confirm(), since the App Router has no supported
 *   route-block API;
 * - the browser Back button — a sentinel history entry: arming pushes a
 *   duplicate of the current entry, so the first Back pops the sentinel
 *   (same URL, no visible change) and we get to ask; cancel re-pushes the
 *   sentinel, confirm issues the real back();
 * - programmatic pushes — confirmUnsavedNavigation() above.
 *
 * All paths deliberately use the browser's native confirm: beforeunload can
 * never be restyled, so a custom dialog on the other paths would make the
 * same question look different depending on how the user tried to leave.
 *
 * After a save the sentinel stays behind (removing it from cleanup would
 * itself navigate), so one extra Back press can be needed on a page that was
 * dirty — harmless, and the alternative is worse.
 */
export function useUnsavedChangesWarning(dirty: boolean, message: string) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const messageRef = useRef(message);
  messageRef.current = message;

  // Register for programmatic navigations (confirmUnsavedNavigation above).
  useEffect(() => {
    const guard = { isDirty: () => dirtyRef.current, message: () => messageRef.current };
    activeGuard = guard;
    return () => {
      if (activeGuard === guard) activeGuard = null;
    };
  }, []);

  // Native prompt for browser-level exits.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Chrome requires returnValue to be set for the prompt to show.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // In-app link clicks: confirm before the router ever sees the click.
  useEffect(() => {
    function onClickCapture(event: MouseEvent) {
      if (!dirtyRef.current) return;
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      if (anchor.getAttribute("target") === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      const url = new URL(href, window.location.href);
      // External destinations fall through to beforeunload.
      if (url.origin !== window.location.origin) return;
      // Same-page (hash/param-only) moves lose nothing.
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      if (!window.confirm(messageRef.current)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, []);

  // Back button: sentinel-entry trap.
  useEffect(() => {
    if (!dirty) return;
    window.history.pushState(window.history.state, "", window.location.href);
    let leaving = false;
    function onPopState() {
      if (leaving || !dirtyRef.current) return;
      if (window.confirm(messageRef.current)) {
        // The sentinel is already consumed; issue the real back.
        leaving = true;
        window.history.back();
      } else {
        // Stay: restore the sentinel (same URL, so the router re-renders nothing).
        window.history.pushState(window.history.state, "", window.location.href);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [dirty]);
}
