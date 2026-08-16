"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface RecoveredDraft<T> {
  savedAt: number;
  data: T;
}

/**
 * Crash/close protection for the editor pages: mirrors the current form state
 * into localStorage (never synced anywhere), debounced, one key per entity
 * (`ms-draft:broadcast:<id|new>` etc.). A draft identical to the persisted
 * baseline is deleted rather than stored, so the key only exists while there
 * is genuinely unsaved work.
 *
 * On mount, an existing differing draft surfaces as `recovered` for the page
 * to offer Restore/Discard — never applied silently. While that offer is
 * pending, the writer stays hands-off so a reload doesn't destroy the draft
 * before the user chose.
 */
export function useLocalDraft<T>({
  storageKey,
  state,
  initialState,
}: {
  storageKey: string;
  /** The current serializable form state; a new identity schedules a write. */
  state: T;
  /** The persisted state the page mounted with — the "nothing unsaved" shape. */
  initialState: T;
}) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const baselineRef = useRef<string>(JSON.stringify(initialState));

  const [recovered, setRecovered] = useState<RecoveredDraft<T> | null>(null);
  const recoveredPendingRef = useRef(false);

  // One-time read: only a draft that differs from the baseline is worth offering.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as RecoveredDraft<T>;
      if (JSON.stringify(parsed.data) !== baselineRef.current) {
        recoveredPendingRef.current = true;
        setRecovered(parsed);
      } else {
        localStorage.removeItem(storageKey);
      }
    } catch {
      // Unreadable storage or corrupt draft — behave as if none existed.
    }
  }, [storageKey]);

  // Debounced write on every state change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect is keyed on the state identity; the body reads through a ref so the timeout always sees the latest
  useEffect(() => {
    const id = setTimeout(() => {
      if (recoveredPendingRef.current) return; // don't clobber an unanswered offer
      try {
        const snapshot = JSON.stringify(stateRef.current);
        if (snapshot === baselineRef.current) {
          localStorage.removeItem(storageKey);
        } else {
          localStorage.setItem(
            storageKey,
            JSON.stringify({ savedAt: Date.now(), data: stateRef.current }),
          );
        }
      } catch {
        // Storage full/unavailable — drafts are best-effort.
      }
    }, 800);
    return () => clearTimeout(id);
  }, [state, storageKey]);

  /** After a successful persist: the current state becomes the baseline. */
  const markSaved = useCallback(() => {
    baselineRef.current = JSON.stringify(stateRef.current);
    recoveredPendingRef.current = false;
    setRecovered(null);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* best-effort */
    }
  }, [storageKey]);

  /** The user declined the recovered draft — forget it. */
  const discardRecovered = useCallback(() => {
    recoveredPendingRef.current = false;
    setRecovered(null);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* best-effort */
    }
  }, [storageKey]);

  /** The user restored the draft — the page applied it; resume mirroring. */
  const acceptRecovered = useCallback(() => {
    recoveredPendingRef.current = false;
    setRecovered(null);
  }, []);

  return { recovered, markSaved, discardRecovered, acceptRecovered };
}
