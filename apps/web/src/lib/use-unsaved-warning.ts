"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { confirmDialog } from "@/components/confirm-dialog";

/* Programmatic navigations (router.push from a component, e.g. the From
   field's add-domain shortcut) never touch an anchor or the history stack the
   guards below watch — so guarded pages register here, and any shared
   component about to router.push awaits confirmUnsavedNavigation() first.
   Editor pages render one at a time, so a single slot suffices. */
let activeGuard: { isDirty: () => boolean; message: () => string } | null = null;

/** Resolves true when navigation may proceed: no dirty guard, or the user confirmed. */
export async function confirmUnsavedNavigation(): Promise<boolean> {
  if (!activeGuard?.isDirty()) return true;
  return confirmDialog({ message: activeGuard.message() });
}

/**
 * Guards against losing unsaved changes on every navigation kind:
 *
 * - tab close / reload / external URLs — the native beforeunload prompt (the
 *   one dialog browsers refuse to let pages restyle);
 * - in-app <Link>/<a> clicks (sidebar included) — a capture-phase interceptor
 *   that always stops the click while dirty, asks through our dialog, and
 *   replays the navigation on confirm;
 * - the browser Back button — a sentinel history entry: arming pushes a
 *   duplicate of the current entry, so the first Back pops the sentinel
 *   (same URL, no visible change) and we get to ask; cancel re-pushes the
 *   sentinel, confirm issues the real back();
 * - programmatic pushes — confirmUnsavedNavigation() above.
 *
 * After a save the sentinel stays behind (removing it from cleanup would
 * itself navigate), so one extra Back press can be needed on a page that was
 * dirty — harmless, and the alternative is worse.
 */
export function useUnsavedChangesWarning(dirty: boolean, message: string) {
  const router = useRouter();
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

  // In-app link clicks: stop the click, ask, replay the navigation on confirm.
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
      event.preventDefault();
      event.stopPropagation();
      void confirmDialog({ message: messageRef.current }).then((ok) => {
        if (ok) router.push(url.pathname + url.search + url.hash);
      });
    }
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [router]);

  // Back button: sentinel-entry trap.
  useEffect(() => {
    if (!dirty) return;
    window.history.pushState(window.history.state, "", window.location.href);
    let leaving = false;
    function onPopState() {
      if (leaving || !dirtyRef.current) return;
      void confirmDialog({ message: messageRef.current }).then((ok) => {
        if (ok) {
          // The sentinel is already consumed; issue the real back.
          leaving = true;
          window.history.back();
        } else {
          // Stay: restore the sentinel (same URL, so the router re-renders nothing).
          window.history.pushState(window.history.state, "", window.location.href);
        }
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [dirty]);
}
