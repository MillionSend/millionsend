"use client";

import { useEffect } from "react";

/**
 * Arms the browser's native "leave site?" confirmation while `dirty` is true.
 * beforeunload guards tab close / reload / external navigation — in-app route
 * changes are not intercepted (App Router has no supported block API).
 */
export function useUnsavedChangesWarning(dirty: boolean) {
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
}
