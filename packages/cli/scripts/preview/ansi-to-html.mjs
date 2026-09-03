// Usage: node ansi-to-html.mjs in.txt out.html
// A vt.mjs screen (text with inline SGR) → <pre class="term"> fragment with one
// <span class="…"> per styled run. Classes: bold, dim, italic, underline,
// inverse, fg-<n> and bg-<n> for the 16 ANSI colors (fg-32, fg-97, fg-90 …),
// fg-38-5-<n> / fg-38-2-<r>-<g>-<b> for extended colors. HTML is escaped.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applySgr, DEFAULT } from "./sgr.mjs";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const classes = (s) =>
  [
    s.bold && "bold",
    s.dim && "dim",
    s.italic && "italic",
    s.underline && "underline",
    s.inverse && "inverse",
    s.fg !== null && `fg-${s.fg.replace(/;/g, "-")}`,
    s.bg !== null && `bg-${s.bg.replace(/;/g, "-")}`,
  ]
    .filter(Boolean)
    .join(" ");

export function toHtml(text) {
  let state = { ...DEFAULT };
  let open = "";
  let out = "";
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (m) {
      state = applySgr(state, m[1]);
      continue;
    }
    if (part === "") continue;
    const cls = classes(state);
    if (cls !== open) {
      if (open !== "") out += "</span>";
      if (cls !== "") out += `<span class="${cls}">`;
      open = cls;
    }
    out += esc(part);
  }
  if (open !== "") out += "</span>";
  return `<pre class="term">${out}\n</pre>\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input, output] = process.argv;
  writeFileSync(output, toHtml(readFileSync(input, "utf8").replace(/\n$/, "")));
}
