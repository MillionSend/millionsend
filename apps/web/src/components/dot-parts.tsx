import { Fragment } from "react";
import { dotParts } from "@/lib/format";
import { Breakable } from "./breakable";

/**
 * A " · "-joined value laid out so a line breaks only between its parts:
 * each part is an inline block (.ms-part) that wraps inside itself only when
 * it is longer than a whole line. `lead` (a status dot) stays on the first
 * part's line; `tail` (a copy chip) is one more part after the last.
 */
export function DotParts({
  text,
  lead,
  tail,
}: {
  text: string;
  lead?: React.ReactNode;
  tail?: React.ReactNode;
}) {
  const parts = dotParts(tail ? `${text} · ` : text);
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and may repeat ("—")
    <Fragment key={i}>
      {i > 0 ? " " : null}
      <span className="ms-part">
        {i === 0 ? lead : null}
        {tail && i === parts.length - 1 ? tail : <Breakable text={part} />}
      </span>
    </Fragment>
  ));
}
