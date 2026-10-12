import type { Db } from "@millionsend/db";
import type { Keyring } from "../crypto/keyring.js";
import type { InboxActor } from "../inboxes/activity.js";
import type { VerificationCodeWire } from "../inboxes/types.js";

/** The newest delivered code or sign-in link; a served code writes code.read activity. */
export async function latestVerificationCode(
  _db: Db,
  _keyring: Keyring,
  _p: {
    teamId: string;
    inboxId: string;
    from: string | null;
    maxAgeMs: number;
    actor: InboxActor;
    now?: Date | undefined;
  },
): Promise<VerificationCodeWire> {
  throw new Error("INBOX_CONTRACT_STUB");
}
