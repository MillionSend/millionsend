/**
 * SECURITY: the From header is a trust boundary. Lenient extractors and MIME
 * builders disagree on multi-mailbox input (one may pick the first angle-addr,
 * another the last), so `Acme <evil@other.com> <ok@mine.com>` could pass
 * domain verification for mine.com yet be emitted as evil@other.com. The only
 * safe policy is to accept EXACTLY one unambiguous mailbox — `local@domain` or
 * `Display Name <local@domain>` — and reject everything else. A rejected send
 * is safe; a silently-rewritten one is not.
 */
export function parseSingleSender(from: string): { address: string; domain: string } | null {
  const input = from.trim();
  // Control characters (CR/LF included) are header-injection vectors.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (input === "" || /[\u0000-\u001F\u007F]/.test(input)) return null;

  // One pass tracking quoted strings, so '@' / '<' / ',' inside a quoted
  // display name ('"weird@name" <a@b.com>') never count as structure.
  let inQuotes = false;
  let escaped = false;
  let open = -1;
  let close = -1;
  let atBeforeOpen = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuotes && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "," || ch === ";") return null; // address list / group syntax
    if (ch === "<") {
      if (open !== -1) return null; // second angle-addr
      open = i;
    } else if (ch === ">") {
      if (open === -1 || close !== -1) return null;
      close = i;
    } else if (ch === "@" && open === -1) {
      atBeforeOpen = true;
    }
  }
  if (inQuotes) return null; // unterminated quoted string

  if (open === -1) return parseAddrSpec(input);

  if (close === -1) return null; // unclosed angle-addr
  if (input.slice(close + 1).trim() !== "") return null; // trailing text after '>'
  // A bare '@' in the display name means a second address-bearing token
  // ('evil@other.com <ok@mine.com>') — ambiguous, reject.
  if (atBeforeOpen) return null;
  return parseAddrSpec(input.slice(open + 1, close));
}

const LOCAL_DOT_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function parseAddrSpec(spec: string): { address: string; domain: string } | null {
  const s = spec.trim();
  let local: string;
  let rest: string;
  if (s.startsWith('"')) {
    // Quoted local part ('"a b"@x.com'): find the closing quote past escapes.
    let i = 1;
    while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
    if (i >= s.length) return null;
    local = s.slice(0, i + 1);
    rest = s.slice(i + 1);
  } else {
    const at = s.lastIndexOf("@");
    if (at === -1) return null;
    local = s.slice(0, at);
    // Rejects a second '@', whitespace, and angle brackets in one check.
    if (!LOCAL_DOT_ATOM.test(local)) return null;
    rest = s.slice(at);
  }
  if (!rest.startsWith("@")) return null;
  const domain = rest.slice(1);
  if (!DOMAIN.test(domain)) return null;
  return { address: `${local}@${domain}`, domain: domain.toLowerCase() };
}
