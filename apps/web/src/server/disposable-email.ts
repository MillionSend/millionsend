import { disposableDomains, isDisposableDomain } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { mailDomain } from "@/lib/format";
import shipped from "../../data/disposable-email-domains.json";

// The disposable-email-domains list (CC0) as this release ships it; the
// worker's daily copy in the database takes over once there is one.
const SHIPPED: ReadonlySet<string> = new Set(shipped);

/** A test for addresses on the disposable list, its domain or a parent of it, read once per batch. */
export async function disposableAddressTest(db: Db): Promise<(email: string) => boolean> {
  const list = await disposableDomains(db, SHIPPED);
  return (email) => isDisposableDomain(mailDomain(email), list);
}
