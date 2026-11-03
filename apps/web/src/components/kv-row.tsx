import { DotParts } from "./dot-parts";

/** A `.ms-kv-cols` value that reads as a sentence, not a figure: sans at the body size. */
export const KV_SENTENCE: React.CSSProperties = {
  fontFamily: "var(--ms-font-sans)",
  fontSize: 13,
};

/**
 * One label/value pair of a `.ms-kv` list (components.css): the value stays
 * on its label's line when it fits and moves under the label when it does
 * not. A string value breaks only between its " · "-joined parts.
 */
export function KvRow({
  label,
  children,
  valueStyle,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div className="ms-kv-row">
      <dt>{label}</dt>
      <dd style={valueStyle}>
        {typeof children === "string" ? <DotParts text={children} /> : children}
      </dd>
    </div>
  );
}
