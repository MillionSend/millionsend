import { slugify } from "@millionsend/core/slug";

/** The local part an inbox's name suggests: its slug, within an address's 64 characters. */
export function localPartFromName(name: string): string {
  return slugify(name).slice(0, 64).replace(/-+$/, "");
}
