import { DotParts } from "./dot-parts";

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
