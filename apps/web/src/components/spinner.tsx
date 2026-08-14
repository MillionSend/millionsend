/** The .ms-spinner rotation ring, size-parametrized (the class fixes 11px). */
export function Spinner({ size = 11 }: { size?: number }) {
  return <span className="ms-spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/**
 * Pending slot for submit buttons: collapsed it cancels the button's 8px flex
 * gap, so the idle button is pixel-identical; while `on` it opens to a 14px
 * spinner left of the label without a layout jump.
 */
export function BtnSpinner({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        overflow: "hidden",
        flex: "none",
        width: on ? 14 : 0,
        marginRight: on ? 0 : -8,
        transition:
          "width var(--ms-dur-fast) var(--ms-ease), margin var(--ms-dur-fast) var(--ms-ease)",
      }}
    >
      {on ? <Spinner size={14} /> : null}
    </span>
  );
}
