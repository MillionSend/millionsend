// SGR state shared by vt.mjs (screen → text with inline SGR) and ansi-to-html.mjs.

export const DEFAULT = Object.freeze({
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  fg: null,
  bg: null,
});

/** Applies one `\x1b[...m` parameter list to a state; unknown codes are ignored. */
export function applySgr(state, params) {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  let s = { ...state };
  for (let i = 0; i < codes.length; i++) {
    const n = codes[i];
    if (n === 0) s = { ...DEFAULT };
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) s.underline = true;
    else if (n === 7) s.inverse = true;
    else if (n === 22) {
      s.bold = false;
      s.dim = false;
    } else if (n === 23) s.italic = false;
    else if (n === 24) s.underline = false;
    else if (n === 27) s.inverse = false;
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) s.fg = String(n);
    else if (n === 39) s.fg = null;
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) s.bg = String(n);
    else if (n === 49) s.bg = null;
    else if (n === 38 || n === 48) {
      // 38;5;n and 38;2;r;g;b: keep the whole extended spec as the color.
      const len = codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
      const spec = codes.slice(i, i + 1 + len).join(";");
      if (n === 38) s.fg = spec;
      else s.bg = spec;
      i += len;
    }
  }
  return s;
}

/** Canonical `\x1b[...m` for a state, "" for the default state. */
export function sgrSeq(s) {
  const codes = [];
  if (s.bold) codes.push(1);
  if (s.dim) codes.push(2);
  if (s.italic) codes.push(3);
  if (s.underline) codes.push(4);
  if (s.inverse) codes.push(7);
  if (s.fg !== null) codes.push(s.fg);
  if (s.bg !== null) codes.push(s.bg);
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}
