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
