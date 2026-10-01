"use client";

import { toast } from "@/components/toast";

/**
 * Whether this session is a read-only support view, for the seams a CSS rule
 * cannot reach: the modal's ⌘↵ confirm, which never goes through a button;
 * confirmDialog(), which is callable from outside React; and useLocalDraft,
 * which must not mirror a customer's editor into the operator's storage. The
 * support view banner owns the flag, since it is mounted exactly while a
 * view is live and unmounted on every route that leaves one; the console's
 * own screens carry no banner, so an operator still acts there as operator.
 *
 * A module flag rather than context because confirmDialog() has no component
 * to read one from, and every seam needs the answer at event time, not at
 * render time.
 */
let readOnly = false;
let refusal = "";

export function setReadOnly(on: boolean, message = ""): void {
  readOnly = on;
  refusal = message;
}

export function isReadOnly(): boolean {
  return readOnly;
}

/** True when the action must not run, having said why where the click was. */
export function refusedAsReadOnly(): boolean {
  if (!readOnly) return false;
  if (refusal) toast(refusal, "danger");
  return true;
}
