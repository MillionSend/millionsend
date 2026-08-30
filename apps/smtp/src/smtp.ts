import {
  type AcceptEmailDeps,
  type ApiKeyAuth,
  acceptEmail,
  authenticateApiKey,
  formatMailbox,
  parseMailbox,
  verifySenderDomain,
} from "@millionsend/core";
import { type AddressObject, simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";

/** Mirrors Resend's SMTP contract: fixed username, an API key as password. */
export const SMTP_USERNAME = "millionsend";

// SESv2 rejects raw messages over 40 MB, and nothing larger can ever send.
export const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

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
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

/** Unexpected failures become a 451 so internals never leak to the client. */
function toSmtpError(err: unknown): Error {
  if (err instanceof Error && "responseCode" in err) return err;
  console.error("smtp internal error", err);
  return smtpError(451, "Temporary local error, please retry");
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
 * MIME message → the shared accept pipeline. Throws errors carrying SMTP
 * response codes: 553/554 validation, 550 all-suppressed.
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
  const html = parsed.html === false ? undefined : parsed.html;
  const text = parsed.text;
  if (html === undefined && text === undefined) {
    throw smtpError(554, "Either an HTML or a text body is required");
  }

  // The authenticated key's team decides which senders are allowed — the
  // MAIL FROM envelope identity is never trusted.
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

  const result = await acceptEmail(deps, auth, {
    from,
    to,
    cc: cc.length > 0 ? cc : undefined,
    bcc: bcc.length > 0 ? bcc : undefined,
    replyTo: replyTo.length > 0 ? replyTo : undefined,
    subject,
    html,
    text,
    domainId: domain.domainId,
  });
  if (!result.ok) {
    if (result.reason === "quota_backlog_full") {
      throw smtpError(452, "Daily quota exceeded and the parked backlog is full");
    }
    if (result.reason === "attachments_too_large") throw smtpError(552, "Attachments too large");
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
    onRcptTo(_address, session, callback) {
      if (session.envelope.rcptTo.length >= MAX_RCPT_TO) {
        callback(smtpError(452, "Too many recipients"));
        return;
      }
      callback();
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
