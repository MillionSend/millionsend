import { FROM_NAME_MAX } from "@millionsend/core/inbox-username";
import { slugify } from "@millionsend/core/slug";

/** The local part an inbox's name suggests: its slug, within an address's 64 characters. */
export function localPartFromName(name: string): string {
  return slugify(name).slice(0, 64).replace(/-+$/, "");
}

/**
 * The sender name an inbox's name suggests: the name within from_name's
 * length, or none when it carries what from_name refuses and a name often
 * has ("@", a colon, angle brackets), so a name like an address never fails
 * the create.
 */
export function fromNameFromName(name: string): string {
  return /[@:<>]/.test(name) ? "" : name.slice(0, FROM_NAME_MAX);
}
