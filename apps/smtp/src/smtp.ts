import {
  type AcceptEmailDeps,
  type ApiKeyAuth,
  acceptEmail,
  authenticateApiKey,
  extractAddrSpec,
  verifySenderDomain,
} from "@millionsend/core";
import { type AddressObject, simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { z } from "zod";

/** Mirrors Resend's SMTP contract: fixed username, an API key as password. */
export const SMTP_USERNAME = "millionsend";

// The HTTP API sets no explicit body cap, so the transport ceiling applies:
// SESv2 rejects raw messages over 40 MB, and nothing larger can ever send.
export const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

export interface SmtpDeps extends AcceptEmailDeps {
  /** STARTTLS keypair; omitted → plaintext with AUTH still allowed. */
  tls?: { key: Buffer; cert: Buffer } | undefined;
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

/** Flatten mailparser address headers back to RFC 5322 mailbox strings. */
function toMailboxes(header: AddressObject | AddressObject[] | undefined): string[] {
  const objects = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const out: string[] = [];
  for (const obj of objects) {
    for (const entry of obj.value) {
      if (!entry.address) continue;
      out.push(entry.name ? `${entry.name} <${entry.address}>` : entry.address);
    }
  }
  return out;
}

// Same rule as the HTTP API's address schema: valid addr-spec, display
// names allowed.
const isValidMailbox = (mailbox: string) => z.email().safeParse(extractAddrSpec(mailbox)).success;

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

  const [from] = toMailboxes(parsed.from);
  if (!from) throw smtpError(553, "A From header with a single address is required");
  const to = toMailboxes(parsed.to);
  if (to.length === 0) throw smtpError(553, "At least one To recipient is required");
  const cc = toMailboxes(parsed.cc);
  const replyTo = toMailboxes(parsed.replyTo);
  // Envelope recipients absent from To/Cc are the BCCs — their addresses
  // never appear in message headers.
  const headerAddrs = new Set([...to, ...cc].map((m) => extractAddrSpec(m).toLowerCase()));
  const bcc = session.envelope.rcptTo
    .map((r) => r.address)
    .filter((a) => !headerAddrs.has(a.toLowerCase()));

  const invalid = [from, ...to, ...cc, ...bcc, ...replyTo].find((m) => !isValidMailbox(m));
  if (invalid !== undefined) throw smtpError(553, `Invalid address: ${invalid}`);

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
  if (!result.ok) throw smtpError(550, "All recipients are suppressed");
  return `Queued as ${result.id}`;
}

/**
 * SMTP relay speaking the same accept pipeline as POST /emails. AUTH
 * PLAIN/LOGIN is required on every session (no open relay): username
 * "millionsend", password an ms_ API key.
 */
export function createSmtpServer(deps: SmtpDeps): SMTPServer {
  return new SMTPServer({
    // Without a keypair STARTTLS is withdrawn and AUTH allowed in
    // plaintext — the self-host posture (own network / TLS-terminating LB).
    ...(deps.tls
      ? { key: deps.tls.key, cert: deps.tls.cert }
      : { hideSTARTTLS: true, allowInsecureAuth: true }),
    authMethods: ["PLAIN", "LOGIN"],
    size: MAX_MESSAGE_BYTES,
    onAuth(auth, _session, callback) {
      void (async () => {
        if (auth.username !== SMTP_USERNAME) {
          throw smtpError(535, `Authentication failed: username must be "${SMTP_USERNAME}"`);
        }
        const verified = auth.password ? await authenticateApiKey(deps.db, auth.password) : null;
        if (!verified) {
          throw smtpError(535, "Authentication failed: password must be a valid API key");
        }
        callback(null, { user: verified });
      })().catch((err) => callback(toSmtpError(err)));
    },
    onData(stream: SMTPServerDataStream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => {
        void (async () => {
          if (stream.sizeExceeded) {
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
