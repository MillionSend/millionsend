// Usage: node vt.mjs in.ansi > out.txt
// Minimal terminal: replays a raw pty transcript (CR, LF, BS, clear-line,
// clear-to-end, cursor up/down/left/right) and prints the FINAL screen, one
// text line per row with the SGR state re-emitted inline wherever it changes.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applySgr, DEFAULT, sgrSeq } from "./sgr.mjs";

const CSI = /\x1b\[([0-9;?]*)([A-Za-z@`])/y;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

export function screen(src) {
  const lines = [[]];
  let row = 0;
  let col = 0;
  let sgr = "";
  let state = { ...DEFAULT };
  const line = () => {
    while (lines.length <= row) lines.push([]);
    return lines[row];
  };
  const put = (ch) => {
    const l = line();
    while (l.length < col) l.push({ ch: " ", sgr: "" });
    l[col++] = { ch, sgr };
  };
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (ch === "\x1b") {
      CSI.lastIndex = i;
      const m = CSI.exec(src);
      if (m) {
        const [, params, cmd] = m;
        const n = Number(params.split(";")[0] || 1);
        if (cmd === "m") {
          state = applySgr(state, params);
          sgr = sgrSeq(state);
        } else if (cmd === "K") {
          const l = line();
          if (params === "2") l.length = 0;
          else if (params === "1")
            for (let c = 0; c < Math.min(col, l.length); c++) l[c] = { ch: " ", sgr: "" };
          else l.length = Math.min(l.length, col);
        } else if (cmd === "J") {
          if (params === "2" || params === "3") for (const l of lines) l.length = 0;
          else if (params === "1") {
            for (let r = 0; r < row; r++) lines[r].length = 0;
            for (let c = 0; c < Math.min(col, line().length); c++)
              lines[row][c] = { ch: " ", sgr: "" };
          } else {
            line().length = Math.min(line().length, col);
            lines.length = row + 1;
          }
        } else if (cmd === "A") row = Math.max(0, row - n);
        else if (cmd === "B") row += n;
        else if (cmd === "C") col += n;
        else if (cmd === "D") col = Math.max(0, col - n);
        else if (cmd === "G") col = Math.max(0, n - 1);
        // ?25l/?25h and everything else: dropped.
        i += m[0].length;
        continue;
      }
      OSC.lastIndex = i;
      const o = OSC.exec(src);
      i += o ? o[0].length : 2; // ESC + one char (ESC=, ESC>, ESC(B …)
      continue;
    }
    if (ch === "\r") col = 0;
    else if (ch === "\n") row++;
    else if (ch === "\x08") col = Math.max(0, col - 1);
    else if (ch === "\t") col += 8 - (col % 8);
    else if (ch >= " " && ch !== "\x7f") {
      const cp = src.codePointAt(i);
      put(String.fromCodePoint(cp));
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    i++;
  }
  return lines
    .map((cells) => {
      while (
        cells.length > 0 &&
        cells[cells.length - 1].ch === " " &&
        cells[cells.length - 1].sgr === ""
      )
        cells.pop();
      let out = "";
      let open = "";
      for (const cell of cells) {
        if (cell.sgr !== open) {
          if (open !== "") out += "\x1b[0m";
          out += cell.sgr;
          open = cell.sgr;
        }
        out += cell.ch;
      }
      if (open !== "") out += "\x1b[0m";
      return out;
    })
    .join("\n")
    .replace(/\n+$/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${screen(readFileSync(process.argv[2], "utf8"))}\n`);
}
