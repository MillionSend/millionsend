"use client";

/** A pill toggle switch — green when on, the knob slides. Our own control. */
export function Switch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 999,
        border: "none",
        padding: 2,
        cursor: disabled ? "default" : "pointer",
        background: checked ? "var(--ms-success)" : "var(--ms-faint)",
        transition: "background 120ms",
      }}
    >
      <span
        style={{
          display: "block",
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "var(--ms-bone)",
          transform: checked ? "translateX(18px)" : "translateX(0)",
          transition: "transform 120ms",
        }}
      />
    </button>
  );
}
