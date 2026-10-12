import type { Db } from "@millionsend/db";

export async function ensureSharedSubdomain(
  _db: Db,
  _p: { teamId: string; teamName: string; sharedInboxDomain: string },
): Promise<{ id: string; name: string }> {
  throw new Error("INBOX_CONTRACT_STUB");
}
