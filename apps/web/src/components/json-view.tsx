import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { resourceHref } from "@/lib/log-body-links";

/** Placeholders the API stores in place of content: "[redacted]", "[html, 12.4 KB]". */
const MARKER_RE = /^\[[a-z]+(?:, [^\]]*)?\]$/;

const INDENT = "  ";

function renderString(value: string, keyPath: string[], requestPath: string): ReactNode {
  const href = resourceHref(requestPath, keyPath, value);
  if (href) {
    return (
      <span className="hljs-string">
        "
        <Link href={href} className="ms-json-link">
          {value}
        </Link>
        "
      </span>
    );
  }
  return (
    <span className={MARKER_RE.test(value) ? "hljs-string ms-json-marker" : "hljs-string"}>
      {JSON.stringify(value)}
    </span>
  );
}

function render(value: unknown, keyPath: string[], depth: number, requestPath: string): ReactNode {
  if (value === null || typeof value === "boolean") {
    return <span className="hljs-literal">{String(value)}</span>;
  }
  if (typeof value === "number") return <span className="hljs-number">{String(value)}</span>;
  if (typeof value === "string") return renderString(value, keyPath, requestPath);
  if (typeof value !== "object") return String(value);
  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      <>
        {"[\n"}
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: JSON array items have no identity beyond position
          <Fragment key={index}>
            {pad}
            {render(item, keyPath, depth + 1, requestPath)}
            {index < value.length - 1 ? ",\n" : "\n"}
          </Fragment>
        ))}
        {close}]
      </>
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return (
    <>
      {"{\n"}
      {entries.map(([key, item], index) => (
        <Fragment key={key}>
          {pad}
          <span className="hljs-attr">{JSON.stringify(key)}</span>
          {": "}
          {render(item, [...keyPath, key], depth + 1, requestPath)}
          {index < entries.length - 1 ? ",\n" : "\n"}
        </Fragment>
      ))}
      {close}
      {"}"}
    </>
  );
}

/**
 * A logged JSON body rendered as hljs-classed spans (the .ms-hl palette in
 * components.css), with every UUID the request path and key attribute to a
 * dashboard resource turned into a link chip. Meant to sit inside a
 * pre.ms-mono.ms-hl with pre-wrap so long strings wrap.
 */
export function JsonView({ value, requestPath }: { value: unknown; requestPath: string }) {
  return <>{render(value, [], 0, requestPath)}</>;
}
