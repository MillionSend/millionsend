/**
 * The one canonical dialog footer: a right-aligned row for a modal's actions.
 * Pass Cancel (ms-btn-secondary, filled) first and Confirm (ms-btn-primary or
 * ms-btn-destructive) second — the flow order the layout preserves left to
 * right. A thin layout wrapper only; it renders whatever buttons it is given.
 */
export function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
      {children}
    </div>
  );
}

/**
 * The confirm-shortcut badge for a dialog's primary button — every dialog
 * shows the same one, matching Modal's onConfirm binding (⌘↵ on Apple
 * platforms, Ctrl↵ elsewhere). Only rendered inside open modals, which never
 * exist at hydration time, so the navigator sniff can't mismatch SSR output.
 */
export function ConfirmKeycap() {
  const mac = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);
  return <span className="ms-keycap">{mac ? "⌘↵" : "Ctrl↵"}</span>;
}
