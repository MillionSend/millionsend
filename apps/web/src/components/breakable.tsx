import { Fragment } from "react";
import { isAddressLike } from "@/lib/format";

/**
 * An address or URL with a line-break opportunity after each "@", "." and
 * "/", so it wraps between its parts before it wraps mid-word. Anything else
 * is left alone: prose has its spaces, and a figure ("153.623") must not
 * break at its separator.
 */
export function Breakable({ text }: { text: string }) {
  if (!isAddressLike(text)) return text;
  return text.split(/(?<=[@./])/).map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and may repeat
    <Fragment key={i}>
      {i > 0 ? <wbr /> : null}
      {part}
    </Fragment>
  ));
}
