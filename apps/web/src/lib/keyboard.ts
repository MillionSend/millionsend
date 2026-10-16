/** Whether a modal dialog covers the page, so a page-level shortcut would act behind it. */
export function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Whether a page-level keyboard shortcut must leave a key alone: the key was
 * typed into a field (an input other than a checkbox or radio, a textarea, a
 * select, or a contenteditable such as the message editor) or inside a
 * dialog, or a modal dialog covers the page and the shortcut would act behind it.
 */
export function shortcutBlocked(target: EventTarget | null): boolean {
  if (modalOpen()) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[role="dialog"]')) return true;
  if (target instanceof HTMLInputElement) {
    return target.type !== "checkbox" && target.type !== "radio";
  }
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Open layers that close on Esc themselves: menus and listboxes, tooltips, dialogs, the phone nav drawer. */
const ESC_LAYERS = '.ms-menu, .ms-tooltip, [role="dialog"], .ms-drawer-scrim';

/**
 * Whether an Esc belongs to something before the page: a field, or anywhere in
 * the message editor (its toolbar included), where it must never throw away
 * what was typed; or an open layer that closes on it.
 */
export function escapeTaken(target: EventTarget | null): boolean {
  return (
    shortcutBlocked(target) ||
    (target instanceof Element && target.closest(".ms-maily") !== null) ||
    document.querySelector(ESC_LAYERS) !== null
  );
}

/** Tab stops inside a panel that runs its own focus loop (dialogs, anchored editors). */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside `panel` while focus is in it: past the last stop it wraps
 * to the first, and Shift+Tab the other way. False when focus is outside the
 * panel or the panel has no other stop, so Tab may leave.
 */
export function loopTab(
  event: Pick<KeyboardEvent, "shiftKey" | "preventDefault">,
  panel: HTMLElement | null,
): boolean {
  if (!panel?.contains(document.activeElement)) return false;
  const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0,
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last || first === last) return false;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
}
