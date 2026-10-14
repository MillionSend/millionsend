/**
 * An address as typed or pasted into a form, with every space taken out: no
 * address holds one, and system mail prints the reader's own address with
 * hair spaces so no mail client links it, so a copy of it must still work.
 */
export function typedEmail(value: string): string {
  return value.replace(/\s/g, "");
}

/** An address typed into a list of them, lowercase as the server stores it. */
export function typedListAddress(value: string): string {
  return typedEmail(value).toLowerCase();
}

/** An allowlist entry as typed: an address, or a domain ("acme.example", "@acme.example") as "*@domain". */
export function typedAllowlistEntry(value: string): string {
  const entry = typedListAddress(value);
  if (entry.startsWith("@")) return `*${entry}`;
  return entry.includes("@") ? entry : `*@${entry}`;
}
