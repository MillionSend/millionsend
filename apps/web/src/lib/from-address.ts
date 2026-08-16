/**
 * Editing-side split/compose of a From value for the composer's structured
 * field (display name · local part · domain). Deliberately forgiving — a
 * half-typed value still lands in the right box — because the API stays
 * authoritative at send time via core's parseSingleSender.
 */
export interface FromParts {
  name: string;
  local: string;
  domain: string;
}

export function splitFromAddress(value: string): FromParts {
  const input = value.trim();
  if (!input) return { name: "", local: "", domain: "" };

  let name = "";
  let addr = input;
  const open = input.indexOf("<");
  if (open !== -1) {
    name = input
      .slice(0, open)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\(.)/g, "$1");
    addr = input.slice(open + 1).replace(/>\s*$/, "");
  }

  const at = addr.lastIndexOf("@");
  if (at === -1) return { name, local: addr.trim(), domain: "" };
  return { name, local: addr.slice(0, at).trim(), domain: addr.slice(at + 1).trim() };
}

/** RFC 5322 atext plus space — anything else forces a quoted display name. */
const UNQUOTED_NAME_RE = /^[A-Za-z0-9 !#$%&'*+/=?^_`{|}~.-]*$/;

export function composeFromAddress({ name, local, domain }: FromParts): string {
  const addr = local.trim() && domain.trim() ? `${local.trim()}@${domain.trim()}` : "";
  if (!addr) return "";
  const display = name.trim();
  if (!display) return addr;
  const quoted = UNQUOTED_NAME_RE.test(display)
    ? display
    : `"${display.replace(/([\\"])/g, "\\$1")}"`;
  return `${quoted} <${addr}>`;
}
