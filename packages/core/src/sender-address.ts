export interface Mailbox {
  name?: string | undefined;
  address: string;
}

/**
 * SECURITY: every address field is a trust boundary. Lenient extractors and
 * MIME builders disagree on multi-mailbox input (one may pick the first
 * angle-addr, another the last; one splits on commas, another expands
 * groups), so `Acme <evil@other.com> <ok@mine.com>` could pass domain
 * verification or a suppression check for one address yet be delivered to
 * another. The only safe policy is to accept EXACTLY one unambiguous mailbox
 * — `local@domain`, `Display Name <local@domain>` or `"Display Name"
 * <local@domain>` — and reject everything else. A rejected send is safe; a
 * silently-rewritten one is not.
 *
 * A display name containing '@' is rejected even when quoted: mobile clients
 * render only the name, so `"ceo@victim.com" <a@team.com>` reads as mail from
 * the victim.
 */
export function parseMailbox(input: string): Mailbox | null {
  const trimmed = input.trim();
  // Control characters (CR/LF included) are header-injection vectors.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (trimmed === "" || /[\u0000-\u001F\u007F]/.test(trimmed)) return null;

  // One pass tracking quoted strings, so '<' / ',' inside a quoted display
  // name ('"a <b> c, d" <a@b.com>') never count as structure.
  let inQuotes = false;
  let escaped = false;
  let open = -1;
  let close = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
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
    }
  }
  if (inQuotes) return null; // unterminated quoted string

  if (open === -1) {
    const address = parseAddrSpec(trimmed);
    return address === null ? null : { address };
  }

  if (close === -1) return null; // unclosed angle-addr
  if (trimmed.slice(close + 1).trim() !== "") return null; // trailing text after '>'
  const phrase = trimmed.slice(0, open).trim();
  if (phrase.includes("@")) return null;
  const address = parseAddrSpec(trimmed.slice(open + 1, close));
  if (address === null) return null;
  const name = unquotePhrase(phrase);
  return name === "" ? { address } : { name, address };
}

/** Decodes a phrase that is exactly one RFC 5322 quoted-string; other phrases pass through. */
function unquotePhrase(phrase: string): string {
  if (phrase.length < 2 || !phrase.startsWith('"') || !phrase.endsWith('"')) return phrase;
  // Reject "a" b "c" (two quoted strings) from being treated as one.
  const inner = phrase.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch === "\\" && i + 1 < inner.length) {
      out += inner[++i];
    } else if (ch === '"') {
      return phrase;
    } else {
      out += ch;
    }
  }
  return out.trim();
}

// RFC 5322 atext plus space: a phrase made only of these needs no quoting.
const PLAIN_PHRASE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\- ]+$/;

/** Canonical serialisation of a mailbox; the display name is quoted whenever atoms cannot carry it. */
export function formatMailbox(m: Mailbox): string {
  const name = m.name?.trim();
  if (!name) return m.address;
  const phrase = PLAIN_PHRASE.test(name) ? name : `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return `${phrase} <${m.address}>`;
}

/**
 * Sender-specific view of parseMailbox: the address plus its lowercased
 * domain, which verification compares against the team's verified domains.
 */
export function parseSingleSender(from: string): { address: string; domain: string } | null {
  const mailbox = parseMailbox(from);
  if (!mailbox) return null;
  const domain = mailbox.address.slice(mailbox.address.lastIndexOf("@") + 1).toLowerCase();
  return { address: mailbox.address, domain };
}

const LOCAL_DOT_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function parseAddrSpec(spec: string): string | null {
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
  return `${local}@${domain}`;
}
