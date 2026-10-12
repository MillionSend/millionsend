import type { InboxSafety } from "@millionsend/db/schema";
import { z } from "zod";
import { asciiHostname } from "../org-domain.js";
import { parseMailbox, routableAddress } from "../sender-address.js";
import { INBOX_ALLOWLIST_MAX, INBOX_FORWARD_TO_MAX, INBOX_OWNER_ADDRESSES_MAX } from "./limits.js";
import type { InboxKind } from "./types.js";

export type { InboxSafety };

const SHARED_SEND_CAP_MAX = 50;
const SEND_CAP_MAX = 100_000;

const dedupe = (values: string[]): string[] => [...new Set(values)];

/** A bare local@domain, lowercased with an IDNA domain; plus tags kept as written. */
function bareAddress(value: string): string | null {
  const mailbox = parseMailbox(value);
  if (!mailbox || mailbox.name !== undefined || value.includes("<")) return null;
  return routableAddress(mailbox.address)?.address.toLowerCase() ?? null;
}

const address = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const bare = bareAddress(value);
    if (bare === null) {
      ctx.addIssue({ code: "custom", message: `"${value}" is not an email address` });
      return z.NEVER;
    }
    return bare;
  });

/** "local@domain", or "*@domain" for a domain and its subdomains. */
const allowlistEntry = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value.startsWith("*@")) {
      const domain = asciiHostname(value.slice(2));
      if (domain?.includes(".")) return `*@${domain}`;
    } else {
      const bare = bareAddress(value);
      if (bare !== null) return bare;
    }
    ctx.addIssue({
      code: "custom",
      message: `"${value}" must be an address (ana@example.com) or a domain (*@example.com)`,
    });
    return z.NEVER;
  });

/** The whole InboxSafety object, normalized: lowercase entries, duplicates dropped. */
export const inboxSafetySchema = z.strictObject({
  accept_from: z.enum(["anyone", "verified", "allowlist"]),
  allowlist: z.array(allowlistEntry).max(INBOX_ALLOWLIST_MAX).transform(dedupe),
  owner_addresses: z.array(address).max(INBOX_OWNER_ADDRESSES_MAX).transform(dedupe),
  screening: z.boolean(),
  extract_codes: z.boolean(),
  send_policy: z.enum(["reply_only", "allowlist", "open"]),
  require_approval: z.boolean(),
  private_codes: z.boolean(),
  send_cap: z.number().int().nullable(),
  forward_to: z.array(address).max(INBOX_FORWARD_TO_MAX).transform(dedupe),
}) satisfies z.ZodType<InboxSafety>;

/** A PATCH body: any subset of the fields, merged over the stored object before safetyProblem. */
export const inboxSafetyPatchSchema = inboxSafetySchema.partial();

/** What a new inbox gets: agents locked down, people's mailboxes open to anyone. */
export function defaultSafety(kind: InboxKind, shared: boolean): InboxSafety {
  const agent = kind === "agent";
  return {
    accept_from: agent ? "verified" : "anyone",
    allowlist: [],
    owner_addresses: [],
    screening: agent,
    extract_codes: true,
    send_policy: agent || shared ? "reply_only" : "open",
    require_approval: false,
    private_codes: agent,
    send_cap: shared ? SHARED_SEND_CAP_MAX : agent ? 200 : null,
    forward_to: [],
  };
}

/** Why a complete safety object is not allowed for this inbox (the 422 message), or null. */
export function safetyProblem(
  s: InboxSafety,
  ctx: {
    kind: InboxKind;
    shared: boolean;
    /** The team is in the content monitor's new tier (monitorTier). */
    teamTierNew: boolean;
    memberEmails: readonly string[];
  },
): string | null {
  if (ctx.shared && s.send_policy !== "reply_only") {
    return "Addresses on the shared domain only reply inside their threads";
  }
  if (ctx.shared && (s.send_cap === null || s.send_cap < 1 || s.send_cap > SHARED_SEND_CAP_MAX)) {
    return `send_cap must be between 1 and ${SHARED_SEND_CAP_MAX} on the shared domain`;
  }
  if (s.send_cap !== null && (s.send_cap < 1 || s.send_cap > SEND_CAP_MAX)) {
    return `send_cap must be between 1 and ${SEND_CAP_MAX}, or null`;
  }
  if (s.send_policy === "open" && ctx.teamTierNew) {
    return 'send_policy "open" is not available to a new team yet; use "allowlist" for now';
  }
  if (s.screening && ctx.kind !== "agent") {
    return "screening is available on agent inboxes only";
  }
  // The shared domain is every team's: it forwards only to addresses a member proved.
  const owners = new Set([
    ...ctx.memberEmails.map((email) => email.toLowerCase()),
    ...(ctx.shared ? [] : s.owner_addresses),
  ]);
  const stranger = s.forward_to.find((target) => !owners.has(target.toLowerCase()));
  if (stranger !== undefined) {
    return ctx.shared
      ? `forward_to accepts team members' login addresses only on the shared domain; ${stranger} is not one`
      : `forward_to accepts team members' login addresses and owner_addresses only; ${stranger} is neither`;
  }
  return null;
}
