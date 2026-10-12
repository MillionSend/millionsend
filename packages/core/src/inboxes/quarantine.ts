import type { Db } from "@millionsend/db";
import type { ListQuery, QuarantinedItemWire } from "./types.js";

/** inboxId null: virus-held catch-all rows, which belong to no inbox. */
export async function listQuarantined(
  _db: Db,
  _p: { teamId: string; inboxId: string | null; query: ListQuery },
): Promise<{ data: QuarantinedItemWire[]; hasMore: boolean } | "bad_cursor"> {
  throw new Error("INBOX_CONTRACT_STUB");
}
