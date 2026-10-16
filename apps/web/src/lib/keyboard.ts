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
