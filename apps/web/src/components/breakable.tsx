import { Fragment } from "react";
import { isAddressLike } from "@/lib/format";

/**
 * Text whose addresses, URLs and domains get a line-break opportunity after
 * each "@", "." and "/", so they wrap between their parts before they wrap
 * mid-word ("Ana <ana@example.com>, bob@example.com" too). Every other word
 * is left alone: prose has its spaces, and a figure ("153.623") must not
 * break at its separator.
 */
export function Breakable({ text }: { text: string }) {
  if (!/[@./]/.test(text)) return text;
  return text.split(/(\s+)/).map((word, w) =>
    isAddressLike(word.replace(/[,;]$/, "")) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: words are positional and may repeat
      <Fragment key={w}>
        {word.split(/(?<=[@./])/).map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and may repeat
          <Fragment key={i}>
            {i > 0 ? <wbr /> : null}
            {part}
          </Fragment>
        ))}
      </Fragment>
    ) : (
      word
    ),
  );
}

/**
 * Display text whose hyphenated words ("e-mail", "sexta-feira") never break
 * at their hyphen: each stays on one line, so a heading that must wrap breaks
 * between words. The characters are unchanged, so a copy keeps the plain
 * hyphen. Not for data: a domain must still break when longer than a line.
 */
export function KeepHyphenated({ text }: { text: string }) {
  if (!/\p{L}-\p{L}/u.test(text)) return text;
  return text.split(/(\S*\p{L}-\p{L}\S*)/u).map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and may repeat
      <span key={i} style={{ whiteSpace: "nowrap" }}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
