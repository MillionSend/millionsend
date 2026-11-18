import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { formatMailbox } from "../sender-address.js";
import type { InboxActor, ParsedInboxActor } from "./activity.js";
import { type ReplyFromName, replyFromName } from "./reply-from-rules.js";

export * from "./reply-from-rules.js";

type DbReplyFromName = (typeof schema.inboxReplyFromNameEnum.enumValues)[number];
// Fails to compile when the pgEnum and REPLY_FROM_NAMES drift apart.
const enumsAgree: [DbReplyFromName, ReplyFromName] extends [ReplyFromName, DbReplyFromName]
  ? true
  : never = true;
void enumsAgree;

export async function accountName(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return row?.name ?? null;
}

/** The From of a send from the inbox, by replyFromName; the account name is read only when it could apply. */
export async function senderFrom(
  db: Db,
  p: {
    inbox: {
      fromName: string | null;
      domainId: string | null;
      replyFromName: ReplyFromName;
      emailAddress: string;
    };
    actor: InboxActor | ParsedInboxActor;
    mode?: ReplyFromName | null | undefined;
  },
): Promise<string> {
  const userName =
    p.actor.kind === "user" && p.inbox.domainId !== null
      ? await accountName(db, p.actor.userId)
      : null;
  const name = replyFromName({ ...p, userName });
  return formatMailbox({ name: name ?? undefined, address: p.inbox.emailAddress });
}
