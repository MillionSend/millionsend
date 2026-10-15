import {
  type AcceptEmailDeps,
  type ApiKeyAuth,
  acceptEmail,
  authenticateApiKey,
  customHeaderIssues,
  findLiveInbox,
  formatMailbox,
  hasHeaderControlChar,
  INBOX_KEY_FROM_MESSAGE,
  isSharedInboxSender,
  MAX_SUBJECT_LENGTH,
  monthlyQuotaMessage,
  msgIds,
  parseMailbox,
  parseSingleSender,
  reservedSenderRefusal,
  SES_MAX_MESSAGE_BYTES,
  SHARED_REPLY_ONLY_MESSAGE,
  sendRefusalError,
  type UndeliverableReason,
  undeliverableRecipientMessage,
  undeliverableRecipients,
  unstorableValueMessage,
  verifySenderDomain,
} from "@millionsend/core";
import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";

/** Mirrors Resend's SMTP contract: fixed username, an API key as password. */
export const SMTP_USERNAME = "millionsend";

// Nothing larger than SES takes can ever send.
export const MAX_MESSAGE_BYTES = SES_MAX_MESSAGE_BYTES;

/** Same per-field cap as POST /emails, applied to the envelope. */
export const MAX_RCPT_TO = 50;
export const MAX_CLIENTS = 100;
export const MAX_CONNECTIONS_PER_IP = 10;
/** Failed AUTH attempts per connection before it is dropped. */
export const MAX_AUTH_FAILURES = 3;

export interface SmtpDeps extends AcceptEmailDeps {
  /** STARTTLS keypair; omitted → AUTH stays disabled unless explicitly allowed. */
  tls?: { key: Buffer; cert: Buffer } | undefined;
  /** Private-network escape hatch. Never enable on an untrusted network. */
  allowInsecureAuth?: boolean | undefined;
  /** Defaults to MAX_MESSAGE_BYTES; lowered only by tests. */
  maxMessageBytes?: number | undefined;
  /** ONBOARDING_EMAIL_FROM: refused as a From like on the HTTP API. */
  onboardingEmailFrom?: string | undefined;
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

/**
 * Unexpected failures become a 451 so internals never leak to the client. A
 * value the database cannot store fails on every retry, so it is a 554.
 */
function toSmtpError(err: unknown): Error {
  if (err instanceof Error && "responseCode" in err) return err;
  const unstorable = unstorableValueMessage(err);
  if (unstorable) return smtpError(554, unstorable);
  console.error("smtp internal error", err);
  return smtpError(451, "Temporary local error, please retry");
}

/** 5.1.2: bad destination system address (RFC 3463). */
function undeliverableError(hit: { address: string; reason: UndeliverableReason }): Error {
  return smtpError(550, `5.1.2 ${undeliverableRecipientMessage(hit, { forSend: true })}`);
}

/**
 * Flatten mailparser address headers to canonical single-mailbox strings.
 * Re-serialising through formatMailbox + parseMailbox rejects what the strict
 * parser rejects (control characters in decoded encoded-word names, names
 * carrying an address, malformed addr-specs). Group members carry no address
 * of their own and are dropped: the envelope decides delivery anyway.
 */
function toMailboxes(header: AddressObject | AddressObject[] | undefined, field: string): string[] {
  const objects = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const out: string[] = [];
  for (const obj of objects) {
    for (const entry of obj.value) {
      if (!entry.address) continue;
      const mailbox = formatMailbox({ name: entry.name || undefined, address: entry.address });
      if (!parseMailbox(mailbox)) throw smtpError(553, `Invalid ${field} address`);
      out.push(mailbox);
    }
  }
  return out;
}

const addrKey = (mailbox: string): string =>
  (parseMailbox(mailbox)?.address ?? mailbox).toLowerCase();

/**
 * In-Reply-To and References as msg-ids, through the same header rules as
 * POST /emails, so a reply over SMTP threads like one over the API.
 */
function threadingHeaders(parsed: ParsedMail): Record<string, string> | undefined {
  const inReplyTo = msgIds(parsed.inReplyTo)[0];
  const references = msgIds(parsed.references);
  const headers: Record<string, string> = {
    ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
    ...(references.length > 0 ? { References: references.join(" ") } : {}),
  };
  const [issue] = customHeaderIssues(headers);
  if (issue) throw smtpError(554, issue.message);
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * MIME message → the shared accept pipeline. Throws errors carrying SMTP
 * response codes: 553/554 validation, 550 all-suppressed or suspended, 451
 * while the team's sending is paused.
 */
async function handleMessage(
  deps: SmtpDeps,
  auth: ApiKeyAuth,
  session: SMTPServerSession,
  raw: Buffer,
): Promise<string> {
  const parsed = await simpleParser(raw);

  // Same boundary as POST /emails, which rejects attachments today.
  if (parsed.attachments.length > 0) {
    throw smtpError(554, "Attachments are not yet supported");
  }

  const [from] = toMailboxes(parsed.from, "From");
  if (!from) throw smtpError(553, "A From header with a single address is required");
  const replyTo = toMailboxes(parsed.replyTo, "Reply-To");

  // The envelope is authoritative, as for any MTA: only RCPT TO addresses
  // are delivered. To/Cc headers decide which of them are visible; the rest
  // are BCCs, whose addresses never appear in message headers.
  const envelope = session.envelope.rcptTo.map((r) => r.address);
  if (envelope.some((a) => !parseMailbox(a))) throw smtpError(553, "Invalid envelope recipient");
  const envelopeKeys = new Set(envelope.map(addrKey));
  const to = toMailboxes(parsed.to, "To").filter((m) => envelopeKeys.has(addrKey(m)));
  if (to.length === 0) {
    throw smtpError(553, "At least one To recipient must also be an envelope recipient");
  }
  const cc = toMailboxes(parsed.cc, "Cc").filter((m) => envelopeKeys.has(addrKey(m)));
  const headerKeys = new Set([...to, ...cc].map(addrKey));
  const bcc = envelope.filter((a) => !headerKeys.has(addrKey(a)));

  const subject = parsed.subject;
  if (!subject) throw smtpError(553, "A non-empty Subject header is required");
  if (hasHeaderControlChar(subject)) {
    throw smtpError(554, "Subject must not contain control characters");
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw smtpError(554, `Subject must be at most ${MAX_SUBJECT_LENGTH} characters`);
  }
  const html = parsed.html === false ? undefined : parsed.html;
  const text = parsed.text;
  if (html === undefined && text === undefined) {
    throw smtpError(554, "Either an HTML or a text body is required");
  }

  // SECURITY: an inbox-scoped key sends from its inbox address and no other.
  if (auth.inboxId !== null) {
    const inbox = await findLiveInbox(deps.db, { teamId: auth.teamId, inboxId: auth.inboxId });
    if (parseSingleSender(from)?.address.toLowerCase() !== inbox?.emailAddress) {
      throw smtpError(550, `5.7.1 ${INBOX_KEY_FROM_MESSAGE}`);
    }
  }
  const headers = threadingHeaders(parsed);

  // The authenticated key's team decides which senders are allowed — the
  // MAIL FROM envelope identity is never trusted.
  const reserved = reservedSenderRefusal(from, deps.onboardingEmailFrom);
  if (reserved) throw smtpError(550, reserved.message);
  if (isSharedInboxSender(from, deps.sharedInboxDomain)) {
    throw smtpError(550, `5.7.1 ${SHARED_REPLY_ONLY_MESSAGE}`);
  }
  const domain = await verifySenderDomain(deps.db, auth.teamId, from);
  if (!domain.ok) {
    throw smtpError(
      554,
      `The ${domain.fromDomain ?? "sender"} domain is not verified for this team`,
    );
  }
  // SECURITY: a domain-scoped key may only send from its one domain — the same
  // scope the HTTP send surface enforces, applied here so SMTP is no bypass.
  if (auth.domainId !== null && auth.domainId !== domain.domainId) {
    throw smtpError(550, "This API key can only send from its assigned domain");
  }

  const result = await acceptEmail(
    deps,
    auth,
    {
      from,
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      replyTo: replyTo.length > 0 ? replyTo : undefined,
      subject,
      html,
      text,
      headers,
      domainId: domain.domainId,
    },
    {
      // A refusal would bounce the message at the client's server: a hold
      // that ends in a release must not have lost it.
      parkUnderReview: true,
      // Every recipient here is an envelope recipient, checked at RCPT TO.
      recipientsChecked: true,
    },
  );
  // acceptEmail reads the team's admission per message, as the HTTP API
  // does: a suspension or a pause lands on the next message of an open
  // session, not on its next AUTH.
  if (!result.ok) {
    // The pause lifts by itself as the trailing rates fall, so the client
    // keeps the message and retries; a suspension waits on the operator.
    if (result.reason === "sending_paused") {
      throw smtpError(451, `4.7.1 ${sendRefusalError(result).message}`);
    }
    if (result.reason === "team_suspended") {
      throw smtpError(550, sendRefusalError(result).message);
    }
    if (result.reason === "quota_backlog_full") {
      throw smtpError(452, "Daily quota exceeded and the parked backlog is full");
    }
    if (result.reason === "warmup_backlog_full") {
      throw smtpError(452, "New domain warm-up: enough mail is already waiting");
    }
    if (result.reason === "monthly_quota_exceeded") {
      throw smtpError(452, monthlyQuotaMessage(result));
    }
    if (result.reason === "attachments_too_large") throw smtpError(552, "Attachments too large");
    if (result.reason === "inbox_scope") throw smtpError(550, `5.7.1 ${INBOX_KEY_FROM_MESSAGE}`);
    if (result.reason === "inbox_send_policy") {
      throw smtpError(
        550,
        `5.7.1 The sending inbox's rules hold this email${result.reasons.length > 0 ? ` (${result.reasons.join(", ")})` : ""}; create it as a draft for a person to approve`,
      );
    }
    if (result.reason === "inbox_send_cap_reached") {
      throw smtpError(452, "4.3.1 Daily send limit for this inbox reached");
    }
    if (result.reason === "undeliverable_recipient") {
      throw undeliverableError({ address: result.address, reason: result.why });
    }
    throw smtpError(550, "All recipients are suppressed");
  }
  return `Queued as ${result.id}`;
}

/**
 * SMTP relay speaking the same accept pipeline as POST /emails. AUTH
 * PLAIN/LOGIN is required on every session (no open relay): username
 * "millionsend", password an ms_ API key.
 */
export function createSmtpServer(deps: SmtpDeps): SMTPServer {
  const maxMessageBytes = deps.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const connectionsByIp = new Map<string, number>();
  // Sessions admitted by onConnect; onClose also fires for rejected ones.
  const admitted = new Set<string>();
  const authFailures = new Map<string, number>();
  // Refused recipients never enter the envelope, so the envelope cap can't
  // bound how many domain checks one session drives.
  const rcptRefusals = new Map<string, number>();
  return new SMTPServer({
    // Without a keypair STARTTLS is withdrawn. Plaintext AUTH requires an
    // explicit opt-in; smtp-server otherwise rejects it before onAuth.
    ...(deps.tls
      ? { key: deps.tls.key, cert: deps.tls.cert }
      : { hideSTARTTLS: true, allowInsecureAuth: deps.allowInsecureAuth ?? false }),
    authMethods: ["PLAIN", "LOGIN"],
    size: maxMessageBytes,
    maxClients: MAX_CLIENTS,
    onConnect(session, callback) {
      const open = connectionsByIp.get(session.remoteAddress) ?? 0;
      if (open >= MAX_CONNECTIONS_PER_IP) {
        callback(smtpError(421, "Too many connections from your address, try again later"));
        return;
      }
      connectionsByIp.set(session.remoteAddress, open + 1);
      admitted.add(session.id);
      callback();
    },
    onClose(session) {
      authFailures.delete(session.id);
      rcptRefusals.delete(session.id);
      if (!admitted.delete(session.id)) return;
      const open = (connectionsByIp.get(session.remoteAddress) ?? 1) - 1;
      if (open <= 0) connectionsByIp.delete(session.remoteAddress);
      else connectionsByIp.set(session.remoteAddress, open);
    },
    onAuth(auth, session, callback) {
      void (async () => {
        if (auth.username !== SMTP_USERNAME) {
          throw smtpError(535, `Authentication failed: username must be "${SMTP_USERNAME}"`);
        }
        const verified = auth.password ? await authenticateApiKey(deps.db, auth.password) : null;
        if (!verified) {
          throw smtpError(535, "Authentication failed: password must be a valid API key");
        }
        callback(null, { user: verified });
      })().catch((err) => {
        const failures = (authFailures.get(session.id) ?? 0) + 1;
        authFailures.set(session.id, failures);
        // 421 makes smtp-server close the connection after the reply.
        callback(
          failures >= MAX_AUTH_FAILURES
            ? smtpError(421, "Too many failed authentication attempts")
            : toSmtpError(err),
        );
      });
    },
    onRcptTo(address, session, callback) {
      if ((rcptRefusals.get(session.id) ?? 0) >= MAX_RCPT_TO) {
        // 421 makes smtp-server close the connection after the reply.
        callback(smtpError(421, "Too many refused recipients"));
        return;
      }
      if (session.envelope.rcptTo.length >= MAX_RCPT_TO) {
        callback(smtpError(452, "Too many recipients"));
        return;
      }
      void (async () => {
        const [hit] = await undeliverableRecipients([address.address]);
        if (!hit) return null;
        // A check that settles after the client hung up must not outlive onClose.
        if (admitted.has(session.id)) {
          rcptRefusals.set(session.id, (rcptRefusals.get(session.id) ?? 0) + 1);
        }
        return undeliverableError(hit);
      })().then(
        (refusal) => callback(refusal),
        // A failed check never refuses a recipient.
        (err) => {
          console.error("smtp recipient check failed", err);
          callback();
        },
      );
    },
    onData(stream: SMTPServerDataStream, session, callback) {
      const chunks: Buffer[] = [];
      let received = 0;
      // smtp-server only flags an oversized message; the bytes still arrive.
      // Stop retaining them past the cap so a huge DATA cannot exhaust memory.
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxMessageBytes) chunks.length = 0;
        else chunks.push(chunk);
      });
      stream.once("end", () => {
        void (async () => {
          if (stream.sizeExceeded || received > maxMessageBytes) {
            throw smtpError(552, "Message exceeds the maximum size");
          }
          // Set by onAuth; auth is mandatory, so a missing user is a bug.
          const auth = session.user as unknown as ApiKeyAuth | undefined;
          if (!auth) throw smtpError(530, "Authentication required");
          return handleMessage(deps, auth, session, Buffer.concat(chunks));
        })().then(
          (message) => callback(null, message),
          (err) => callback(toSmtpError(err)),
        );
      });
    },
  });
}
