/**
 * An address as typed or pasted into a form, with every space taken out: no
 * address holds one, and system mail prints the reader's own address with
 * hair spaces so no mail client links it, so a copy of it must still work.
 */
export function typedEmail(value: string): string {
  return value.replace(/\s/g, "");
}
