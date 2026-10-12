import { countInvisible, dropInvisible } from "../customer-text.js";
import { MIN_BODY_TEXT_CHARS } from "../email-insights.js";
import { decodeEntities, visibleText } from "../html.js";

export { decodeEntities };

/**
 * What a reader sees of an email body. Regex-driven, with no DOM: inline
 * styles and the `<style>` rules reached by type, class, id, descendant and
 * child selectors are resolved; attribute selectors, pseudo-classes and
 * sibling combinators are not, and a selector using one is skipped.
 */

/** Block elements, the characters a QR code is drawn with in text. Global: replace or match only. */
const BLOCK_ELEMENTS = /[\u2580-\u259f]/g;

type Rgba = readonly [number, number, number, number];
type Declaration = readonly [prop: string, value: string, important: boolean];
type Declarations = Map<string, { value: string; important: boolean }>;

interface Element {
  tag: string;
  id: string | null;
  classes: string[];
  /** The keys rules are indexed by that it carries: #id, each .class, its tag. */
  keys: string[];
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  /** Its id, else its first class, else its tag, else "*": the key rules are indexed and pre-checked by. */
  key: string;
}

interface Rule {
  compounds: Compound[];
  /** child[i]: compounds[i] must be the parent of compounds[i + 1], not just an ancestor. */
  child: boolean[];
  specificity: number;
  order: number;
  declarations: Declaration[];
}

interface Sheet {
  /** Rules that always apply, by the key of their last compound: under no condition, or one every screen meets. */
  base: Map<string, Rule[]>;
  /** Rules under a media or supports condition only some real screens meet. */
  conditional: Map<string, Rule[]>;
  /** A rule that hides was left unresolved: its selector is not read, or its condition holds on some screens only. */
  unresolved: boolean;
}

/** An element as the walk keeps it: what it inherits to its text and children. */
interface Frame extends Element {
  /** Computed font size, px. */
  em: number;
  /** Text colour; null when it cannot be known. */
  color: Rgba | null;
  /** What shows behind the text; "image" when that cannot be known. */
  bg: Rgba | "image";
  /** visibility, which a descendant can set back to visible. */
  visible: boolean;
}

/**
 * Why text was taken out, the read pipeline's hidden-text flags; invisible
 * characters add their own (customer-text InvisibleClass).
 */
export type HiddenFlag =
  | "display_none"
  | "visibility"
  | "opacity"
  | "font_size"
  | "zero_size"
  | "offscreen"
  | "clip"
  | "same_color"
  | "hidden_attribute"
  | "comment"
  | "template"
  | "noscript"
  | "css_unresolved";

/** The only properties the resolver reads; every other declaration is dropped on parse. */
const STYLE_PROPS = new Set([
  "display",
  "visibility",
  "opacity",
  "font",
  "font-size",
  "color",
  "background",
  "background-color",
  "background-image",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "overflow",
  "overflow-x",
  "overflow-y",
  "clip",
  "clip-path",
  "text-indent",
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "margin-left",
  "margin-top",
  "transform",
]);

/** Never drawn by a mail client that reads their text: their whole content is hidden. */
const HIDDEN_TAGS = new Map<string, HiddenFlag>([
  ["template", "template"],
  // Shown only where scripting is off; agents read what scripting clients show.
  ["noscript", "noscript"],
]);

const BLACK: Rgba = [0, 0, 0, 1];
const WHITE: Rgba = [255, 255, 255, 1];
const LINK_BLUE: Rgba = [0, 0, 238, 1];
const NO_CLASSES: string[] = [];
const ROOT: Frame = {
  tag: "",
  id: null,
  classes: NO_CLASSES,
  keys: [],
  em: 16,
  color: BLACK,
  bg: WHITE,
  visible: true,
};

/** Enough names for white-on-white and its near misses; any other name compares as written. */
const NAMED_COLORS = new Map([
  ["white", "#ffffff"],
  ["black", "#000000"],
  ["silver", "#c0c0c0"],
  ["gray", "#808080"],
  ["grey", "#808080"],
  ["red", "#ff0000"],
  ["maroon", "#800000"],
  ["yellow", "#ffff00"],
  ["olive", "#808000"],
  ["lime", "#00ff00"],
  ["green", "#008000"],
  ["aqua", "#00ffff"],
  ["teal", "#008080"],
  ["blue", "#0000ff"],
  ["navy", "#000080"],
  ["fuchsia", "#ff00ff"],
  ["purple", "#800080"],
  ["snow", "#fffafa"],
  ["ghostwhite", "#f8f8ff"],
  ["whitesmoke", "#f5f5f5"],
  ["ivory", "#fffff0"],
  ["azure", "#f0ffff"],
  ["aliceblue", "#f0f8ff"],
  ["honeydew", "#f0fff0"],
  ["mintcream", "#f5fffa"],
  ["floralwhite", "#fffaf0"],
  ["seashell", "#fff5ee"],
  ["lavenderblush", "#fff0f5"],
]);

/** Colour channels this close read as the same colour: the text cannot be told from its ground. */
const SAME_COLOR_DISTANCE = 16;
/** Below this opacity, text is not there for a reader. */
const MIN_OPACITY = 0.1;
/** A text-indent, a positioned box's offset or a translation this far left or up puts the text off the page. */
const OFF_PAGE_INDENT_PX = -500;
/** Width or height at or under this many px, with overflow hidden, shows nothing. */
const COLLAPSED_PX = 1;
/** An image declared this small (a tracking pixel, a spacer) is no picture. */
const TINY_IMAGE_PX = 2;

const MAX_RULES = 2000;
const MAX_COMPOUNDS = 8;
const MAX_CLASSES = 32;
/**
 * Rule checks, ancestor steps and matched rules all selector matching may
 * take for one body, and the rules one element may draw. A 400 KB newsletter
 * with hundreds of rules uses about a quarter of the budget. Past either the
 * walk stops resolving and reads the rest of the body as hidden, so padding a
 * stylesheet to exhaust them buys a sender nothing.
 */
const MATCH_BUDGET = 10_000_000;
const MAX_CANDIDATES = 512;

// The lookahead, not \b, ends the name: \b lets a hyphenated name give back
// characters, and each give-back rescans the attributes, quadratic on a
// crafted unclosed tag.
const TAG = /<(\/?)([a-z][a-z0-9:-]*)(?![a-z0-9:-])([^<>]*)>/gi;
const OPEN_TAG = /<([a-z][a-z0-9:-]*)(?![a-z0-9:-])([^<>]*)>/gi;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
// An unclosed <style> swallows the rest, as a browser does, so no scan restarts from each one.
const STYLE_BLOCK = /<style\b[^<>]*>(?:([\s\S]*?)<\/style\s*>|([\s\S]*))/gi;
const CSS_COMMENT = /\/\*(?:[\s\S]*?\*\/|[\s\S]*)/g;
// A CSS escape: up to six hex digits and one optional space, or any other character as itself.
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi;
// HTML comments as a browser ends them (<!--> and <!---> are empty ones), or a
// style or script element, whose "<!--" is no comment and which is kept whole.
const COMMENT_OR_RAW =
  /<(style|script)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)|<!--(?:-?>|[\s\S]*?(?:--!?>|$))/gi;
// Outlook's conditional comment, which only Outlook renders as markup.
const CONDITIONAL_COMMENT = /^<!--\[if\b[^\]]*\]>([\s\S]*?)(?:<!\[endif\]\s*|<!)?(?:--!?>)?$/i;
const RAW_TEXT_CLOSE = new Map([
  ["style", /<\/style\s*>/gi],
  ["script", /<\/script\s*>/gi],
]);
/** Elements that never hold content: no end tag closes them. */
export const VOID_TAGS: ReadonlySet<string> = new Set([
  "img",
  "br",
  "hr",
  "input",
  "meta",
  "link",
  "area",
  "col",
  "wbr",
  "source",
  "track",
  "embed",
  "param",
  "base",
]);
const BLOCK_TAGS = new Set(
  "address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr main menu nav ol p pre section table ul".split(
    " ",
  ),
);
/** The open element a new one closes without an end tag, as an HTML parser does: <p>a<p>b are siblings. */
export const IMPLIED_END: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["p", BLOCK_TAGS],
  ["li", new Set(["li"])],
  ["td", new Set(["td", "th", "tr"])],
  ["th", new Set(["td", "th", "tr"])],
  ["tr", new Set(["tr"])],
  ["option", new Set(["option"])],
]);
/**
 * The attributes that can change what a reader sees; an element without one
 * looks like its parent. A slash or a quote separates attributes for a
 * browser as whitespace does (<span/style=...>).
 */
const STYLING_ATTR =
  /(?:^|[\s/"'])(?:style|class|id|hidden|bgcolor|background|color|text|href)(?=[\s=/]|$)/i;
/** Attributes and tags that can carry an image, to skip parsing the rest. */
const IMAGE_ATTR = /background|url\(/i;
const IMAGE_TAGS = new Set(["img", "v:imagedata", "v:fill", "v:image", "image", "svg"]);
const COMPOUND = /^(\*|[a-z][a-z0-9-]*)?((?:[.#][a-z_-][\w-]*)*)$/i;
// Numbers are written so a run of digits splits only one way: \d*\.?\d+
// backtracks quadratically on a long run that then fails.
const LENGTH = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|pt|em|rem|%)?$/;
// The size inside a `font` shorthand: a length with a unit, or a bare 0, before a /line-height or a space.
const FONT_SHORTHAND_SIZE = /(?:^|\s)((?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|%)|0)(?=\/|\s|$)/;

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = (m[1] as string).toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!attrs.has(name)) attrs.set(name, value.includes("&") ? decodeEntities(value) : value);
  }
  return attrs;
}

function elementOf(tag: string, attrs: Map<string, string>): Element {
  const id = attrs.get("id")?.toLowerCase() ?? null;
  const classes = [
    ...new Set((attrs.get("class") ?? "").toLowerCase().split(/\s+/).filter(Boolean)),
  ].slice(0, MAX_CLASSES);
  return {
    tag,
    id,
    classes,
    keys: [...(id ? [`#${id}`] : []), ...classes.map((c) => `.${c}`), tag],
  };
}

function parseDeclarations(raw: string): Declaration[] {
  const out: Declaration[] = [];
  // A browser reads "display:/**/none" and "d\69 splay:none" as display:none.
  let css = raw.includes("/*") ? raw.replace(CSS_COMMENT, "") : raw;
  if (css.includes("\\")) {
    css = css.replace(CSS_ESCAPE, (_, hex: string | undefined, ch: string | undefined) => {
      if (hex === undefined) return ch ?? "";
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
        ? String.fromCodePoint(cp)
        : "\ufffd";
    });
  }
  for (const part of css.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (!STYLE_PROPS.has(prop)) continue;
    const value = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const bang = value.lastIndexOf("!");
    const important = bang !== -1 && /^!\s*important$/.test(value.slice(bang));
    out.push([prop, important ? value.slice(0, bang).trim() : value, important]);
  }
  return out;
}

function parseSelector(text: string): Omit<Rule, "order" | "declarations"> | null {
  const compounds: Compound[] = [];
  const child: boolean[] = [];
  let specificity = 0;
  let pendingChild = false;
  for (const token of text.replace(/>/g, " > ").trim().split(/\s+/)) {
    if (token === ">") {
      if (compounds.length === 0 || pendingChild) return null;
      pendingChild = true;
      continue;
    }
    const m = COMPOUND.exec(token);
    if (!m || token === "") return null;
    const tag = m[1] && m[1] !== "*" ? m[1].toLowerCase() : null;
    let id: string | null = null;
    const classes: string[] = [];
    for (const part of m[2]?.match(/[.#][^.#]+/g) ?? []) {
      if (part[0] === ".") classes.push(part.slice(1).toLowerCase());
      else if (id === null) id = part.slice(1).toLowerCase();
      else return null;
    }
    specificity += (id ? 10_000 : 0) + classes.length * 100 + (tag ? 1 : 0);
    if (compounds.length > 0) child.push(pendingChild);
    pendingChild = false;
    const key = id ? `#${id}` : classes[0] ? `.${classes[0]}` : (tag ?? "*");
    compounds.push({ tag, id, classes, key });
  }
  if (pendingChild || compounds.length === 0 || compounds.length > MAX_COMPOUNDS) return null;
  return { compounds, child, specificity };
}

const WIDTH_BOUND = /(min|max)-(?:device-)?width\s*:\s*(\d+(?:\.\d+)?)px/gi;

/** A media or supports condition some real screen meets: not print only, no freak width bound. */
function someScreen(prelude: string): boolean {
  if (/\bprint\b/i.test(prelude) && !/\b(?:screen|all)\b/i.test(prelude)) return false;
  for (const m of prelude.matchAll(WIDTH_BOUND)) {
    const px = Number(m[2]);
    if (m[1]?.toLowerCase() === "min" ? px > 2000 : px < 200) return false;
  }
  return true;
}

/**
 * A condition every screen meets, so its rules hide as if unconditioned: a
 * supports test, or media types and width bounds no real screen falls
 * outside of ((min-width:1px)). Any other media feature (dark mode, an
 * orientation) holds on some screens only.
 */
function everyScreen(prelude: string): boolean {
  if (!someScreen(prelude)) return false;
  if (/^@supports\b/i.test(prelude)) return true;
  const rest = prelude
    .replace(/^@media\b/i, "")
    .replace(WIDTH_BOUND, (_, kind: string, px: string) =>
      (kind.toLowerCase() === "min" ? Number(px) <= 100 : Number(px) >= 10_000) ? "" : "bound",
    )
    .replace(/\b(?:only|screen|all|and)\b|[()\s,]/gi, "");
  return rest === "";
}

/** Whether a rule's declarations would take an element out of view. */
function declarationsHide(declarations: Declaration[]): boolean {
  const props: Declarations = new Map(
    declarations.map(([prop, value, important]) => [prop, { value, important }]),
  );
  return (
    hideReason(props, 16) !== null ||
    /^(?:hidden|collapse)$/.test(props.get("visibility")?.value ?? "")
  );
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i;
  }
  return css.length;
}

/**
 * Every `<style>` block's rules, in source order. ponytail: the first
 * MAX_RULES selectors only; a stylesheet padded past them hides the rest of
 * its rules from the resolver.
 */
function parseSheet(html: string): Sheet {
  const sheet: Sheet = { base: new Map(), conditional: new Map(), unresolved: false };
  let order = 0;
  const add = (prelude: string, block: string, conditional: boolean) => {
    const declarations = parseDeclarations(block);
    if (declarations.length === 0) return;
    let hides: boolean | undefined;
    const unresolved = () => {
      hides ??= declarationsHide(declarations);
      if (hides) sheet.unresolved = true;
    };
    if (conditional) unresolved();
    for (const text of prelude.split(",")) {
      if (order >= MAX_RULES) return;
      const selector = parseSelector(text);
      if (!selector) {
        unresolved();
        continue;
      }
      const index = conditional ? sheet.conditional : sheet.base;
      const key = (selector.compounds.at(-1) as Compound).key;
      const rule: Rule = { ...selector, order: order++, declarations };
      const rules = index.get(key);
      if (rules) rules.push(rule);
      else index.set(key, [rule]);
    }
  };
  const walk = (css: string, conditional: boolean, depth: number) => {
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf("{", i);
      if (open === -1) return;
      // A statement at-rule (@import, @charset) ends at its semicolon, before the next block.
      const head = css.slice(i, open);
      const prelude = head.slice(head.lastIndexOf(";") + 1).trim();
      if (prelude.startsWith("@")) {
        const close = matchingBrace(css, open);
        if (depth < 3 && /^@(?:media|supports)\b/i.test(prelude) && someScreen(prelude)) {
          walk(css.slice(open + 1, close), conditional || !everyScreen(prelude), depth + 1);
        }
        i = close + 1;
        continue;
      }
      const close = css.indexOf("}", open);
      add(prelude, css.slice(open + 1, close === -1 ? css.length : close), conditional);
      if (close === -1) return;
      i = close + 1;
    }
  };
  for (const m of html.matchAll(STYLE_BLOCK)) {
    // CSS reads "<!--" and "-->" (old mail wraps its rules in them) as nothing.
    walk((m[1] ?? m[2] ?? "").replace(CSS_COMMENT, "").replace(/<!--|-->/g, " "), false, 0);
  }
  return sheet;
}

function compoundMatches(c: Compound, el: Element): boolean {
  return (
    (c.tag === null || c.tag === el.tag) &&
    (c.id === null || c.id === el.id) &&
    c.classes.every((k) => el.classes.includes(k))
  );
}

/** Rules whose last compound matches the element, its ancestors not looked at. */
function candidates(index: Map<string, Rule[]>, el: Element): Rule[] {
  return [...el.keys, "*"].flatMap((key) =>
    (index.get(key) ?? []).filter((r) => compoundMatches(r.compounds.at(-1) as Compound, el)),
  );
}

function cascade(rules: Rule[], inline: Declaration[]): Declarations {
  const out: Declarations = new Map();
  const apply = ([prop, value, important]: Declaration) => {
    if (important || !out.get(prop)?.important) out.set(prop, { value, important });
  };
  for (const rule of [...rules].sort(
    (a, b) => a.specificity - b.specificity || a.order - b.order,
  )) {
    rule.declarations.forEach(apply);
  }
  inline.forEach(apply);
  return out;
}

function toPx(value: string | undefined, em: number): number | null {
  const m = value === undefined ? null : LENGTH.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "px":
      return n;
    case "pt":
      return (n * 4) / 3;
    case "em":
      return n * em;
    case "rem":
      return n * 16;
    case undefined:
      return n === 0 ? 0 : null;
    default:
      return null;
  }
}

/** An HTML width or height attribute: a bare number is pixels. */
function attrPx(value: string | undefined): number | null {
  const m = value === undefined ? null : /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

function parseColor(raw: string): Rgba | null {
  const value = NAMED_COLORS.get(raw) ?? raw;
  if (value === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return [at(0), at(2), at(4), full.length === 8 ? at(6) / 255 : 1];
  }
  const rgb =
    /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      value,
    );
  if (!rgb) return null;
  const channel = (s: string) =>
    s.endsWith("%") ? (Number(s.slice(0, -1)) * 255) / 100 : Number(s);
  const alpha =
    rgb[4] === undefined
      ? 1
      : rgb[4].endsWith("%")
        ? Number(rgb[4].slice(0, -1)) / 100
        : Number(rgb[4]);
  const color: Rgba = [
    channel(rgb[1] as string),
    channel(rgb[2] as string),
    channel(rgb[3] as string),
    alpha,
  ];
  return color.every(Number.isFinite) ? color : null;
}

function firstColor(shorthand: string): Rgba | null {
  for (const m of shorthand.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^()]*\)|[a-z]+/g)) {
    const color = parseColor(m[0]);
    if (color) return color;
  }
  return null;
}

/** The element's own background: a colour, "image" when what shows cannot be known, null when unset. */
function backgroundOf(props: Declarations, attrs: Map<string, string>): Rgba | "image" | null {
  const image = props.get("background-image")?.value;
  const shorthand = props.get("background")?.value;
  if (
    (image !== undefined && image !== "none") ||
    (shorthand !== undefined && /url\(|gradient\(/.test(shorthand)) ||
    attrs.has("background")
  ) {
    return "image";
  }
  const declared = props.get("background-color")?.value;
  const color =
    declared !== undefined
      ? parseColor(declared)
      : shorthand !== undefined
        ? firstColor(shorthand)
        : parseColor(attrs.get("bgcolor")?.trim().toLowerCase() ?? "");
  if (color) return color[3] > 0 ? color : null;
  return declared !== undefined || attrs.has("bgcolor") ? "image" : null;
}

/** The element's text colour: its own, a presentational attribute's, a link's blue, or its parent's. */
function textColor(
  tag: string,
  attrs: Map<string, string>,
  props: Declarations,
  parent: Frame,
): Rgba | null {
  const attr = tag === "font" ? attrs.get("color") : tag === "body" ? attrs.get("text") : undefined;
  const value = props.get("color")?.value ?? attr?.trim().toLowerCase();
  if (value === undefined) return tag === "a" && attrs.has("href") ? LINK_BLUE : parent.color;
  return value === "inherit" || value === "currentcolor" ? parent.color : parseColor(value);
}

function fontSize(props: Declarations, parent: number): number {
  const shorthand = props.get("font")?.value;
  const raw =
    props.get("font-size")?.value ??
    (shorthand === undefined ? undefined : FONT_SHORTHAND_SIZE.exec(shorthand)?.[1]);
  if (raw === undefined || raw === "inherit") return parent;
  if (raw === "smaller") return parent / 1.2;
  if (raw === "larger") return parent * 1.2;
  if (/^(?:(?:xx?-)?(?:small|large)|medium|initial|unset)$/.test(raw)) return 13;
  if (raw.endsWith("%")) {
    const n = Number(raw.slice(0, -1));
    return Number.isFinite(n) ? (n / 100) * parent : parent;
  }
  return toPx(raw, parent) ?? parent;
}

function clipHides(value: string | undefined): boolean {
  const rect = value && /^rect\(([^()]*)\)/.exec(value)?.[1];
  if (!rect) return false;
  const [top, right, bottom, left] = rect
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => toPx(s, 16));
  return (
    (top != null && bottom != null && bottom <= top) ||
    (left != null && right != null && right <= left)
  );
}

function clipPathHides(value: string | undefined): boolean {
  if (!value) return false;
  if (/^(?:circle|ellipse)\(\s*0(?:px|%)?(?=[\s)]|$)/.test(value)) return true;
  const polygon = /^polygon\(([^()]*)\)/.exec(value)?.[1];
  if (polygon !== undefined) {
    return polygon
      .split(/[\s,]+/)
      .filter(Boolean)
      .every((s) => /^0(?:px|%)?$/.test(s));
  }
  const inset = /^inset\(([^()]*)\)/.exec(value)?.[1]?.split(/\sround\s/)[0];
  if (inset === undefined) return false;
  const pct = inset
    .trim()
    .split(/\s+/)
    .map((s) => (s.endsWith("%") ? Number(s.slice(0, -1)) : Number.NaN));
  const [top = Number.NaN, right = top, bottom = top, left = right] = pct;
  return top + bottom >= 100 || left + right >= 100;
}

/** A transform that shrinks the box to nothing, or moves it off the page. */
function transformHides(value: string | undefined): HiddenFlag | null {
  if (!value) return null;
  if (/\bscale[xy]?\(\s*0(?:\.0+)?\s*[,)]/.test(value)) return "zero_size";
  for (const m of value.matchAll(/\btranslate[xy]?\(\s*(-(?:\d+(?:\.\d+)?|\.\d+))px/g)) {
    if (Number(m[1]) <= OFF_PAGE_INDENT_PX) return "offscreen";
  }
  return null;
}

/**
 * Why the element's declarations take it and everything inside it out of
 * view, or null. Visibility is inherited instead (a descendant can show
 * again), so it is read per frame.
 */
function hideReason(props: Declarations, em: number): HiddenFlag | null {
  const get = (prop: string) => props.get(prop)?.value;
  if (get("display") === "none") return "display_none";
  const opacity = get("opacity");
  if (opacity !== undefined) {
    const n = opacity.endsWith("%") ? Number(opacity.slice(0, -1)) / 100 : Number(opacity);
    if (n < MIN_OPACITY) return "opacity";
  }
  if (toPx(get("max-height"), em) === 0) return "zero_size";
  const overflowHidden = ["overflow", "overflow-x", "overflow-y"].some((p) =>
    /^(?:hidden|clip)\b/.test(get(p) ?? ""),
  );
  if (
    overflowHidden &&
    ["width", "height", "max-width", "max-height"].some((p) => {
      const px = toPx(get(p), em);
      return px !== null && px <= COLLAPSED_PX;
    })
  ) {
    return "zero_size";
  }
  if (clipHides(get("clip")) || clipPathHides(get("clip-path"))) return "clip";
  const indent = get("text-indent");
  if (indent !== undefined) {
    const px = toPx(indent, em);
    if (px !== null && px <= OFF_PAGE_INDENT_PX) return "offscreen";
    if (indent.endsWith("%") && Number(indent.slice(0, -1)) <= -100) return "offscreen";
  }
  if (/^(?:absolute|fixed)$/.test(get("position") ?? "")) {
    for (const side of ["left", "top", "right", "bottom", "margin-left", "margin-top"]) {
      const px = toPx(get(side), em);
      if (px !== null && px <= OFF_PAGE_INDENT_PX) return "offscreen";
    }
  }
  return transformHides(get("transform"));
}

function sameColor(a: Rgba, b: Rgba): boolean {
  return [0, 1, 2].every(
    (i) => Math.abs((a[i] as number) - (b[i] as number)) <= SAME_COLOR_DISTANCE,
  );
}

/** Why text in this element is not seen: hidden, too small, transparent, or the colour of its ground. */
function textHidden(frame: Frame): HiddenFlag | null {
  if (!frame.visible) return "visibility";
  if (frame.em <= 1) return "font_size";
  const color = frame.color;
  if (!color) return null;
  if (color[3] < MIN_OPACITY) return "same_color";
  return frame.bg !== "image" && sameColor(color, frame.bg) ? "same_color" : null;
}

function readable(run: string): boolean {
  return dropInvisible(decodeEntities(visibleText(run))).trim() !== "";
}

export interface VisibleHtml {
  /** The html without its hidden elements, hidden runs of text and comments. */
  html: string;
  /** Text a reader cannot see, decoded, in document order: salting and text written for scanners. */
  hidden: string;
  /**
   * Hidden text ahead of anything visible: the inbox preview line, which an
   * inbox lists under the subject while the open message hides it.
   */
  preview: string;
  /** Characters of hidden text, the preview's included. */
  hiddenChars: number;
  /** Why anything was taken out, sorted; never the text itself. */
  flags: HiddenFlag[];
}

/**
 * Takes out what a reader cannot see: comments (Outlook's conditional ones
 * read as hidden text), template and noscript content, elements hidden by
 * the `hidden` attribute, an inline style or a stylesheet rule (display,
 * opacity, a collapsed, clipped, scaled or off-page box, zero max-height),
 * and runs of text set invisible, at 1px or less, transparent, or in their
 * background's colour. An element shown again by a media or supports rule
 * (a mobile-only block) stays; a hiding rule under a condition every screen
 * meets applies. Closing tags pop the open elements back to their match, so
 * malformed nesting can still fool it.
 */
export function stripHiddenElements(input: string): VisibleHtml {
  const flags = new Set<HiddenFlag>();
  // Comments go before anything else reads the body: a tag inside one is no
  // tag, and a stylesheet inside one applies nowhere.
  const outlookOnly: string[] = [];
  const html = input.includes("<!--")
    ? input.replace(COMMENT_OR_RAW, (m: string, raw: string | undefined) => {
        if (raw) return m;
        flags.add("comment");
        const conditional = CONDITIONAL_COMMENT.exec(m)?.[1];
        if (conditional) outlookOnly.push(conditional);
        return "";
      })
    : input;
  const sheet = parseSheet(html);
  const hasRules = sheet.base.size > 0 || sheet.conditional.size > 0;
  const out: string[] = [];
  const hidden: string[] = [];
  const preview: string[] = [];
  const stack: Frame[] = [];
  // Open elements' keys (tag, #id, .class) with how many hold each: rules out a
  // selector whose ancestor no open element could match before any walk.
  const keys = new Map<string, number>();
  let budget = MATCH_BUDGET;
  let removedAt = -1;
  let seenVisible = false;
  let cursor = 0;

  const count = (frame: Frame, delta: number) => {
    for (const key of frame.keys) keys.set(key, (keys.get(key) ?? 0) + delta);
  };
  // An element with no styling attribute that no rule names by tag looks like
  // its parent: the bulk of any body, so it skips the cascade.
  const plainKeys = new Map<string, string[]>();
  const plainFrame = (tag: string, parent: Frame): Frame | null => {
    if (budget > 0 && (sheet.base.has(tag) || sheet.base.has("*"))) return null;
    let keys = plainKeys.get(tag);
    if (!keys) {
      keys = [tag];
      plainKeys.set(tag, keys);
    }
    const { em, color, bg, visible } = parent;
    return { tag, id: null, classes: NO_CLASSES, keys, em, color, bg, visible };
  };
  const has = (key: string) => key === "*" || (keys.get(key) ?? 0) > 0;
  /** Whether the rule's ancestor compounds match the open elements; its last one already matched. */
  const ancestorsMatch = (rule: Rule): boolean => {
    const last = rule.compounds.length - 1;
    for (let k = 0; k < last; k++) if (!has((rule.compounds[k] as Compound).key)) return false;
    let i = stack.length - 1;
    for (let k = last - 1; k >= 0; k--) {
      const c = rule.compounds[k] as Compound;
      if (rule.child[k]) {
        if (i < 0 || !compoundMatches(c, stack[i] as Frame)) return false;
        i--;
        continue;
      }
      while (i >= 0 && !compoundMatches(c, stack[i] as Frame)) {
        i--;
        budget--;
      }
      if (i < 0) return false;
      i--;
    }
    return true;
  };
  const matched = (index: Map<string, Rule[]>, el: Element): Rule[] => {
    const keys = [...el.keys, "*"];
    if (keys.reduce((n, key) => n + (index.get(key)?.length ?? 0), 0) > MAX_CANDIDATES) {
      budget = 0;
      return [];
    }
    const rules: Rule[] = [];
    for (const key of keys) {
      for (const rule of index.get(key) ?? []) {
        budget--;
        if (compoundMatches(rule.compounds.at(-1) as Compound, el) && ancestorsMatch(rule)) {
          rules.push(rule);
        }
      }
    }
    budget -= rules.length * 8;
    return rules;
  };

  const text = (run: string) => {
    if (run === "") return;
    const top = stack.at(-1) ?? ROOT;
    const reason = removedAt !== -1 ? null : budget <= 0 ? "css_unresolved" : textHidden(top);
    if (removedAt !== -1 || reason) {
      if (reason && run.trim() !== "") flags.add(reason);
      (seenVisible ? hidden : preview).push(run);
      return;
    }
    out.push(run);
    if (!seenVisible && top.tag !== "title" && readable(run)) seenVisible = true;
  };

  for (const m of html.matchAll(TAG)) {
    if (m.index < cursor) continue;
    text(html.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const tag = (m[2] as string).toLowerCase();
    const removed = removedAt !== -1;
    if (m[1]) {
      // The nearest open element of that name; the ones above it close with it.
      let at = -1;
      if (has(tag)) {
        for (let i = stack.length - 1; i >= 0 && at === -1; i--) {
          if ((stack[i] as Frame).tag === tag) at = i;
        }
      }
      // A close that ends a visible element is kept even from inside a hidden one.
      if (!removed || (at !== -1 && at < removedAt)) out.push(m[0]);
      while (at !== -1 && stack.length > at) count(stack.pop() as Frame, -1);
      if (removedAt >= stack.length) removedAt = -1;
      continue;
    }
    const close = RAW_TEXT_CLOSE.get(tag);
    if (close) {
      close.lastIndex = cursor;
      const end = close.exec(html);
      const to = end ? end.index + end[0].length : html.length;
      if (!removed) out.push(html.slice(m.index, to));
      cursor = to;
      continue;
    }
    for (let top = stack.at(-1); top && IMPLIED_END.get(top.tag)?.has(tag); top = stack.at(-1)) {
      count(stack.pop() as Frame, -1);
      if (removedAt >= stack.length) removedAt = -1;
    }
    const raw = m[3] as string;
    const parent = stack.at(-1) ?? ROOT;
    const tagReason = HIDDEN_TAGS.get(tag) ?? null;
    let reason: HiddenFlag | null = tagReason;
    let frame = tagReason || STYLING_ATTR.test(raw) ? null : plainFrame(tag, parent);
    if (!frame) {
      const attrs = parseAttrs(raw);
      const el = elementOf(tag, attrs);
      const inline = parseDeclarations(attrs.get("style") ?? "");
      const own = hasRules && budget > 0 ? matched(sheet.base, el) : [];
      const props = cascade(own, inline);
      const em = fontSize(props, parent.em);
      if (!reason) reason = attrs.has("hidden") ? "hidden_attribute" : hideReason(props, em);
      // A rule only some screens meet can still show what the rest hide (a
      // mobile-only block); the hidden attribute and hidden tags it cannot.
      const styled = reason !== null && reason !== "hidden_attribute" && !tagReason;
      const unseen = /^(?:hidden|collapse)$/.test(props.get("visibility")?.value ?? "");
      let shownProps: Declarations | null = null;
      if ((styled || unseen) && sheet.conditional.size > 0 && budget > 0) {
        const shown = matched(sheet.conditional, el);
        if (shown.length > 0) shownProps = cascade([...own, ...shown], inline);
      }
      if (styled && shownProps && !hideReason(shownProps, em)) reason = null;
      const visibility = (shownProps ?? props).get("visibility")?.value;
      frame = {
        ...el,
        em,
        color: textColor(tag, attrs, props, parent),
        bg: backgroundOf(props, attrs) ?? parent.bg,
        visible:
          visibility === "hidden" || visibility === "collapse"
            ? false
            : visibility === "visible" || visibility === "initial"
              ? true
              : parent.visible,
      };
      // An invisible link is no link a reader can follow: it goes whole, its href with it.
      if (!reason && !frame.visible && (tag === "a" || tag === "area")) reason = "visibility";
    }
    const selfClosing =
      VOID_TAGS.has(tag) || (raw.trimEnd().endsWith("/") && (tag.includes(":") || has("svg")));
    if (removedAt === -1 && reason) {
      flags.add(reason);
      if (!selfClosing) removedAt = stack.length;
    } else if (removedAt === -1) {
      out.push(m[0]);
    }
    if (!selfClosing) {
      stack.push(frame);
      count(frame, 1);
    }
  }
  text(html.slice(cursor));
  if (sheet.unresolved) flags.add("css_unresolved");

  const join = (runs: string[]) => decodeEntities(visibleText(runs.join(" ")));
  const hiddenText = join([...hidden, ...outlookOnly]);
  const previewText = join(preview);
  return {
    html: out.join(""),
    hidden: hiddenText,
    preview: previewText,
    hiddenChars: hiddenText.length + previewText.length,
    flags: [...flags].sort(),
  };
}

/** A tracking pixel or spacer: declared at most 2px on a side, and no stylesheet rule sizes it up. */
/**
 * Rule visits left for one extractImageRefs call. Past it, or past
 * MAX_CANDIDATES rules for one image, an image a stylesheet might resize
 * counts as shown, so a padded stylesheet buys the sender nothing.
 */
interface RuleBudget {
  left: number;
}

function declaredTiny(
  tag: string,
  attrs: Map<string, string>,
  sheet: Sheet,
  budget: RuleBudget,
): boolean {
  const inline = parseDeclarations(attrs.get("style") ?? "");
  const side = (prop: "width" | "height") => {
    const declared = inline.findLast(([p]) => p === prop)?.[1];
    return declared === undefined ? attrPx(attrs.get(prop)) : toPx(declared, 16);
  };
  const width = side("width");
  const height = side("height");
  if (
    !((width !== null && width <= TINY_IMAGE_PX) || (height !== null && height <= TINY_IMAGE_PX))
  ) {
    return false;
  }
  const el = elementOf(tag, attrs);
  const keyed = [...el.keys, "*"].reduce(
    (n, key) => n + (sheet.base.get(key)?.length ?? 0) + (sheet.conditional.get(key)?.length ?? 0),
    0,
  );
  budget.left -= keyed;
  if (keyed > MAX_CANDIDATES || budget.left < 0) return false;
  const declarations = [
    ...inline,
    ...[...candidates(sheet.base, el), ...candidates(sheet.conditional, el)].flatMap(
      (r) => r.declarations,
    ),
  ];
  return !declarations.some(([prop, value]) => {
    if (!/^(?:min-)?(?:width|height)$/.test(prop)) return false;
    const px = toPx(value, 16);
    return px === null ? value.endsWith("%") : px > TINY_IMAGE_PX;
  });
}

const CSS_URL = /url\(\s*["']?([^"'()<>\s]+)["']?\s*\)/gi;

/** The url() values in background and background-image declarations. */
function backgroundUrls(css: string): string[] {
  const urls: string[] = [];
  for (const m of css.matchAll(CSS_URL)) {
    const before = css.slice(Math.max(0, m.index - 256), m.index);
    const declaration = before.slice(
      Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}")) + 1,
    );
    if (/^\s*background(?:-image)?\s*:/i.test(declaration)) urls.push(m[1] as string);
  }
  return urls;
}

export interface ImageRef {
  /** Where the body names the image. */
  source: "img" | "css" | "background" | "vml" | "svg-image" | "inline-svg";
  /** The URL as written, entities decoded (data: and cid: included); for an inline <svg>, its markup. */
  src: string;
}

/**
 * Every image the body shows, each once: <img>, CSS backgrounds (inline and
 * in <style>), the background attribute, Outlook's VML, SVG <image> and
 * inline <svg>. An image declared 2px or smaller is left out; that covers
 * our own open pixel, which is written 1x1. Matching our tracking route by
 * path instead would let any host keep a lure out of the count by serving
 * it under /t/o/.
 */
export function extractImageRefs(html: string): ImageRef[] {
  const sheet = parseSheet(html);
  const budget: RuleBudget = { left: MATCH_BUDGET };
  const refs = new Map<string, ImageRef>();
  const add = (source: ImageRef["source"], src: string | undefined) => {
    const value = src?.trim();
    if (value && !refs.has(value)) refs.set(value, { source, src: value });
  };
  let svgEnd = -1;
  for (const m of html.matchAll(OPEN_TAG)) {
    const tag = (m[1] as string).toLowerCase();
    if (!IMAGE_TAGS.has(tag) && !IMAGE_ATTR.test(m[2] as string)) continue;
    const attrs = parseAttrs(m[2] as string);
    if (tag === "img") {
      if (!declaredTiny(tag, attrs, sheet, budget)) add("img", attrs.get("src"));
    } else if (tag === "v:imagedata" || tag === "v:fill" || tag === "v:image") {
      add("vml", attrs.get("src"));
    } else if (tag === "image") {
      add("svg-image", attrs.get("href") ?? attrs.get("xlink:href"));
    } else if (tag === "svg" && !declaredTiny(tag, attrs, sheet, budget)) {
      // The first </svg> after this one; reused while it still lies ahead, so a
      // run of unclosed <svg> tags is scanned once.
      if (svgEnd <= m.index) {
        const close = /<\/svg\s*>/gi;
        close.lastIndex = m.index;
        const end = close.exec(html);
        svgEnd = end ? end.index + end[0].length : html.length;
      }
      add("inline-svg", html.slice(m.index, svgEnd));
    }
    add("background", attrs.get("background"));
    for (const url of backgroundUrls(attrs.get("style") ?? "")) add("css", url);
  }
  for (const m of html.matchAll(STYLE_BLOCK)) {
    for (const url of backgroundUrls(m[1] ?? m[2] ?? "")) add("css", url);
  }
  return [...refs.values()];
}

/** Empty table cells that carry a fill colour: the pixels of a QR code drawn as a table. */
const FILLED_EMPTY_CELL = /<t[dh]\b([^<>]*)>(?:\s|&nbsp;|&#160;|&#xa0;)*<\/t[dh]\s*>/gi;
const QR_ART_CHARS = 100;
const QR_ART_CELLS = 400;

/** A QR code drawn without an image: in block characters, or as a grid of filled table cells. */
export function hasQrArt(html: string, visible: string): boolean {
  if ((visible.match(BLOCK_ELEMENTS)?.length ?? 0) >= QR_ART_CHARS) return true;
  let cells = 0;
  for (const m of html.matchAll(FILLED_EMPTY_CELL)) {
    if (
      /\bbgcolor\s*=|background(?:-color)?\s*:/i.test(m[1] as string) &&
      ++cells >= QR_ART_CELLS
    ) {
      return true;
    }
  }
  return false;
}

export interface BodyText {
  /** The HTML with what is hidden taken out; null when the body is its text part. */
  stripped: VisibleHtml | null;
  /** What a reader sees: decoded, invisible characters removed. */
  visible: string;
  /** Invisible characters taken out of it. */
  invisible: number;
}

/** The body a reader sees: the HTML's, or the text part when the HTML is missing or blank. */
export function readBody(html: string | null, text: string | null): BodyText {
  const stripped = html?.trim() ? stripHiddenElements(html) : null;
  const raw = stripped ? decodeEntities(visibleText(stripped.html)) : (text ?? "");
  return {
    stripped,
    visible: dropInvisible(raw),
    invisible: countInvisible(raw),
  };
}

export interface OpaqueFacts {
  /** Under MIN_BODY_TEXT_CHARS of readable text, with an image, an attachment or QR art to carry the message. */
  opaque: boolean;
  /** Readable characters, block-drawing characters not counted. */
  visibleChars: number;
  imageRefs: ImageRef[];
  qrArt: boolean;
}

export function opaqueFactsOf(body: BodyText, attachments: number): OpaqueFacts {
  const imageRefs = body.stripped ? extractImageRefs(body.stripped.html) : [];
  const qrArt = hasQrArt(body.stripped?.html ?? "", body.visible);
  const visibleChars = body.visible.replace(BLOCK_ELEMENTS, "").replace(/\s+/g, " ").trim().length;
  return {
    opaque:
      visibleChars < MIN_BODY_TEXT_CHARS && (imageRefs.length > 0 || attachments > 0 || qrArt),
    visibleChars,
    imageRefs,
    qrArt,
  };
}

/**
 * Whether an email carries its message in images, files or QR art rather
 * than text, measured on the text the judge reads.
 */
export function opaqueFacts(body: {
  html: string | null;
  text: string | null;
  attachments: number;
}): OpaqueFacts {
  return opaqueFactsOf(readBody(body.html, body.text), body.attachments);
}
