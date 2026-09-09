export type EmailScheme = "light" | "dark";

/*
 * Approximation of how dark-mode mail clients (Gmail's auto-darkening, Apple
 * Mail with supported-color-schemes) transform a light email: invert + rotate
 * hues, then re-invert media so photos and logos keep their real colors. Full
 * invert(1) both ways keeps images pixel-exact. Preview-only — nothing here
 * ships in a send.
 */
export const DARK_CLIENT_SIM = `<style>
  html { filter: invert(1) hue-rotate(180deg); background: #fff; }
  img, video, [style*="background-image"] { filter: invert(1) hue-rotate(180deg); }
</style>`;

const SCHEME_QUERY = /prefers-color-scheme\s*:\s*(dark|light)/gi;
/* Always-true and always-false stand-ins that keep any surrounding media
   query grammatically valid ("screen and (...)" included). */
const ALWAYS = "min-width: 0px";
const NEVER = "min-width: 999999px";

/** Whether the message carries its own dark-mode treatment, the way a client would detect it. */
export function declaresColorSchemes(html: string): boolean {
  return /prefers-color-scheme|supported-color-schemes|name=["']?color-scheme/i.test(html);
}

/**
 * Preview the message as a client in `scheme` would show it. The iframe reads
 * the viewer's OS preference, not the app's, so both schemes are forced: the
 * message's own prefers-color-scheme rules are switched on or off in place.
 * A message with no dark treatment at all gets what Gmail and friends do to
 * it: the auto-darkening filter.
 */
export function emulateEmailScheme(html: string, scheme: EmailScheme): string {
  const dark = scheme === "dark";
  const declares = declaresColorSchemes(html);
  const forced = html.replace(SCHEME_QUERY, (_m, which: string) =>
    (which.toLowerCase() === "dark") === dark ? ALWAYS : NEVER,
  );
  // The auto-darkening simulation inverts a LIGHT rendering: under
  // color-scheme:dark the UA would already paint unstyled text light, and the
  // invert would turn it dark again (a text-only message reads black on black).
  const simulate = dark && !declares;
  const base = `<style>:root{color-scheme:${simulate ? "light" : scheme}}</style>`;
  return openLinksOutside(forced) + base + (simulate ? DARK_CLIENT_SIM : "");
}

const LINKS_OUTSIDE = '<base target="_blank">';

/**
 * A click in the preview opens in the viewer's own browser. Inside the
 * sandboxed frame a link could only navigate the frame, which the sandbox
 * blocks; the frame's sandbox lets popups out for the same reason. The base
 * goes in the head when there is one, where every browser honours it.
 */
function openLinksOutside(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  return head
    ? `${html.slice(0, head.index + head[0].length)}${LINKS_OUTSIDE}${html.slice(head.index + head[0].length)}`
    : LINKS_OUTSIDE + html;
}
