import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createSecureContext } from "node:tls";
import {
  AUTH_RESULTS,
  type AuthDetail,
  type AuthResult,
  type AuthVerdicts,
  type DeliverEnvelope,
  encodeEnvelopeHeader,
  MAX_ALIGNED_DKIM_DOMAINS,
  MAX_ENVELOPE_RECIPIENT_BYTES,
  MAX_RECEIVED_MESSAGE_BYTES,
  MX_DELIVER_PATH,
  MX_DELIVER_PERMANENT_STATUS,
  MX_DELIVER_TEMPORARY_STATUS,
  MX_ENVELOPE_HEADER,
  MX_RCPT_PATH,
  MX_TEMPORARY_FAILURE,
  type RcptRequest,
  type RcptResponse,
  rcptResponseSchema,
  type SmtpReply,
  smtpReplySchema,
} from "@millionsend/core/receiving-protocol";
import { authenticate, type DNSResolver } from "mailauth";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import type { MxEnv } from "./env.js";

/** How often STARTTLS looks for a renewed certificate: certbot replaces the files in place. */
const TLS_CHECK_INTERVAL_MS = 5 * 60_000;
/** Recipient domains whose /rcpt answers are kept at once; the oldest entry leaves first. */
const RCPT_CACHE_ENTRIES = 10_000;
/** Refused recipients a session may collect before it is dropped, like Postfix's hard error limit. */
const MAX_REFUSED_RECIPIENTS = 20;
/**
 * RFC 6376 lets a verifier limit the signatures it tries. mailauth checks
 * every one, each with its own body hash over up to 40 MiB, so a message
 * carrying more than this is not authenticated at all.
 */
const MAX_DKIM_SIGNATURES = 10;

export interface MxOptions {
  /** Defaults to MAX_RECEIVED_MESSAGE_BYTES; lowered only by tests. */
  maxMessageBytes?: number;
  /** The client waits on every RCPT answer. */
  rcptTimeoutMs?: number;
  /** The app parses, seals and stores up to 40 MiB before it answers. */
  deliverTimeoutMs?: number;
  /** Stalled DNS must not hold the message: past this the verdicts read temperror. */
  authTimeoutMs?: number;
  /** mailauth's DNS lookups; tests answer them without a network. */
  resolver?: DNSResolver;
}

export interface MxServer {
  smtp: SMTPServer;
  /** Loads the STARTTLS keypair when its files changed; also runs on an interval. */
  reloadTls(): void;
  close(): Promise<void>;
}

interface SessionState {
  refused: number;
  timer: NodeJS.Timeout;
  /** Frees the bytes a message still streaming in DATA holds. */
  release?: () => void;
}

/** The part of smtp-server's connection object the session time limit needs. */
interface SmtpConnection {
  id: string;
  send(code: number, message: string): void;
}

/** One JSON object per line, never message content: envelope facts and outcomes only. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ event, ...fields }, (_key, value) =>
      value instanceof Error
        ? { message: value.message, code: (value as { code?: unknown }).code, cause: value.cause }
        : value,
    ),
  );
}

/**
 * The enhanced code leads the reply text. ENHANCEDSTATUSCODES stays
 * unadvertised because smtp-server would then prefix its own guess per code
 * (552 → 5.2.2 instead of 5.3.4, every 550 → 5.1.1).
 */
function smtpError(reply: SmtpReply): Error {
  return Object.assign(new Error(`${reply.enhanced} ${reply.message}`), {
    responseCode: reply.code,
  });
}

/** Anything without an SMTP code is a bug: 451, so the sender retries and no internals leak. */
function asReply(err: unknown): Error {
  if (err instanceof Error && "responseCode" in err) return err;
  log("internal_error", { error: err });
  return smtpError(MX_TEMPORARY_FAILURE);
}

const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * smtp-server (3.19.23 on) refuses a HELO with control characters or past
 * 300 characters; the strip keeps that true whatever the library lets
 * through. The wire allows 255 UTF-16 units, and the cut never leaves half a
 * surrogate pair behind.
 */
const heloOf = (session: SMTPServerSession): string =>
  String(session.hostNameAppearsAs || "")
    .replace(/\p{Cc}/gu, "")
    .slice(0, 255)
    .replace(/[\ud800-\udbff]$/, "");

/** mailauth words outside the wire vocabulary (a check that did not run, BIMI's skipped) read as none. */
const known = (result: string | undefined): AuthResult =>
  (AUTH_RESULTS as readonly string[]).includes(result ?? "") ? (result as AuthResult) : "none";

/** A domain the wire carries: lowercase, at most 253 characters of [a-z0-9.-]; anything else is left out. */
function wireDomain(value: unknown): string | null {
  const domain = typeof value === "string" ? value.toLowerCase().replace(/\.$/, "") : "";
  return /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : null;
}

const DMARC_POLICIES = new Set(["none", "quarantine", "reject"]);

function dkimSignatureCount(raw: Buffer): number {
  const ends = [raw.indexOf("\r\n\r\n"), raw.indexOf("\n\n")].filter((i) => i >= 0);
  const header = raw.subarray(0, ends.length > 0 ? Math.min(...ends) : raw.length);
  return header.toString("latin1").match(/^dkim-signature[ \t]*:/gim)?.length ?? 0;
}

/**
 * The inbound MX: a thin SMTP front door with no database. Every RCPT TO is
 * asked of the app ({MX_INGEST_URL}/rcpt) and every message is handed over
 * ({MX_INGEST_URL}/deliver) before the client hears 250. Anything that goes
 * wrong on the way is a 451, so the sender keeps the message and retries;
 * nothing is ever sent from here, so refusals happen in the session only.
 */
export function createMxServer(env: MxEnv, options: MxOptions = {}): MxServer {
  const maxMessageBytes = options.maxMessageBytes ?? MAX_RECEIVED_MESSAGE_BYTES;
  const rcptTimeoutMs = options.rcptTimeoutMs ?? 15_000;
  const deliverTimeoutMs = options.deliverTimeoutMs ?? 120_000;
  const authTimeoutMs = options.authTimeoutMs ?? 30_000;

  const rcptCache = new Map<string, { answer: RcptResponse; expiresAt: number }>();
  const sessions = new Map<string, SessionState>();
  const openByIp = new Map<string, number>();
  /** Connections per IP in the current minute: a fixed window the tick below clears. */
  const recentByIp = new Map<string, number>();
  let buffered = 0;
  /** The keypair's mtimes once loaded, or the last problem logged, so each is reported once. */
  let tlsSeen = "";

  const post = (
    path: string,
    body: string | Buffer,
    headers: Record<string, string>,
    timeoutMs: number,
  ) =>
    fetch(`${env.ingestUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ingestSecret}`, ...headers },
      body,
      // MX_INGEST_URL names the endpoint itself; following a redirect would
      // resend the secret and the message wherever it points.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

  async function askApp(recipient: string, session: SMTPServerSession): Promise<RcptResponse> {
    const domain = domainOf(recipient);
    const cached = rcptCache.get(domain);
    if (cached && cached.expiresAt > Date.now()) return cached.answer;
    const request: RcptRequest = {
      recipient,
      mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
      clientIp: session.remoteAddress,
      helo: heloOf(session),
    };
    const res = await post(
      MX_RCPT_PATH,
      JSON.stringify(request),
      { "content-type": "application/json" },
      rcptTimeoutMs,
    );
    const parsed = rcptResponseSchema.safeParse(await res.json().catch(() => null));
    if (res.status !== 200 || !parsed.success) {
      throw new Error(
        `/rcpt answered HTTP ${res.status}${parsed.success ? "" : " without an answer"}`,
      );
    }
    const answer = parsed.data;
    if (answer.ttlSeconds > 0) {
      rcptCache.delete(domain);
      rcptCache.set(domain, { answer, expiresAt: Date.now() + answer.ttlSeconds * 1000 });
      if (rcptCache.size > RCPT_CACHE_ENTRIES) {
        rcptCache.delete(rcptCache.keys().next().value as string);
      }
    }
    return answer;
  }

  async function checkRecipient(recipient: string, session: SMTPServerSession): Promise<void> {
    const state = sessions.get(session.id);
    if (state && state.refused >= MAX_REFUSED_RECIPIENTS) {
      throw smtpError({
        code: 421,
        enhanced: "4.7.0",
        message: "Too many refused recipients, closing connection",
      });
    }
    const listed = session.envelope.rcptTo.map((r) => r.address);
    // Measured as the envelope header carries them (JSON-escaped UTF-8), which
    // never undercounts the app's own check of the same budget.
    const bytes = [...listed, recipient].reduce(
      (sum, address) => sum + Buffer.byteLength(JSON.stringify(address)),
      0,
    );
    if (listed.length >= env.maxRecipients || bytes > MAX_ENVELOPE_RECIPIENT_BYTES) {
      log("rcpt_refused", {
        session: session.id,
        ip: session.remoteAddress,
        domain: domainOf(recipient),
        code: 452,
        reason: "recipient_limit",
      });
      throw smtpError({ code: 452, enhanced: "4.5.3", message: "Too many recipients" });
    }
    let answer: RcptResponse;
    try {
      answer = await askApp(recipient, session);
    } catch (err) {
      log("rcpt_failed", { session: session.id, domain: domainOf(recipient), error: err });
      throw smtpError(MX_TEMPORARY_FAILURE);
    }
    if (answer.accept) return;
    if (state && answer.code >= 500) state.refused++;
    log("rcpt_refused", {
      session: session.id,
      ip: session.remoteAddress,
      domain: domainOf(recipient),
      code: answer.code,
    });
    throw smtpError(answer);
  }

  /**
   * The folded verdicts Resend's surface reads, and the unfolded detail
   * trust decisions read. The detail is left out, never made up, whenever
   * authentication did not run to the end (too many signatures, a timeout,
   * an error).
   */
  async function verdicts(
    raw: Buffer,
    client: { ip: string; helo: string; sender: string },
    sessionId: string,
  ): Promise<{ auth: AuthVerdicts; authDetail?: AuthDetail }> {
    const all = (result: AuthResult) => ({
      auth: { spf: result, dkim: result, dmarc: result, arc: result },
    });
    if (dkimSignatureCount(raw) > MAX_DKIM_SIGNATURES) return all("permerror");
    try {
      const result = await Promise.race([
        authenticate(raw, {
          ...client,
          mta: env.hostname,
          disableBimi: true,
          ...(options.resolver ? { resolver: options.resolver } : {}),
        }),
        delay(authTimeoutMs, null, { ref: false }),
      ]);
      if (!result) {
        log("auth_timeout", { session: sessionId });
        return all("temperror");
      }
      const signatures = result.dkim.results;
      const passing = signatures.filter((r) => r.status.result === "pass");
      const spf = known(result.spf ? result.spf.status.result : undefined);
      const unfolded = known(result.dmarc ? result.dmarc.status.result : undefined);
      let dmarc = unfolded;
      // Resend's reading, which agents check before trusting a sender. A
      // valid signature from a domain other than From's says nothing about
      // who wrote the message: RFC 8601's DKIM "policy", reported gray.
      const dkim = passing.some((r) => r.status.aligned)
        ? "pass"
        : passing.length > 0
          ? "policy"
          : known(signatures[0]?.status.result);
      // p=none asks for no enforcement: no verdict once SPF or DKIM passed.
      if (
        result.dmarc &&
        result.dmarc.policy === "none" &&
        (dmarc === "pass" || dmarc === "fail") &&
        (spf === "pass" || passing.length > 0)
      ) {
        dmarc = "none";
      }
      const policy = result.dmarc ? result.dmarc.policy : undefined;
      const authDetail: AuthDetail = {
        spf: { result: spf, domain: wireDomain(result.spf ? result.spf.domain : null) },
        dkim: {
          aligned: [
            ...new Set(
              passing
                .map((r) => (r.status.aligned ? wireDomain(r.signingDomain) : null))
                .filter((d): d is string => d !== null),
            ),
          ].slice(0, MAX_ALIGNED_DKIM_DOMAINS),
        },
        dmarc: {
          result: unfolded,
          policy:
            policy && DMARC_POLICIES.has(policy)
              ? (policy as "none" | "quarantine" | "reject")
              : null,
          domain: wireDomain(result.dmarc ? result.dmarc.status.header?.from : null),
        },
      };
      return {
        auth: { spf, dkim, dmarc, arc: known(result.arc ? result.arc.status.result : undefined) },
        authDetail,
      };
    } catch (err) {
      // The name only: a parser's message could quote the message itself.
      log("auth_failed", { session: sessionId, error: err instanceof Error ? err.name : "error" });
      return all("temperror");
    }
  }

  async function deliver(session: SMTPServerSession, raw: Buffer, receivedAt: Date) {
    const started = Date.now();
    const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
    const helo = heloOf(session);
    const cipher = session.tlsOptions as unknown as { name?: string; version?: string } | false;
    const checked = await verdicts(
      raw,
      { ip: session.remoteAddress, helo, sender: mailFrom },
      session.id,
    );
    const envelope: DeliverEnvelope = {
      mailFrom,
      recipients: session.envelope.rcptTo.map((r) => r.address),
      clientIp: session.remoteAddress,
      helo,
      tls: session.secure && cipher ? { protocol: cipher.version, cipher: cipher.name } : null,
      auth: checked.auth,
      ...(checked.authDetail ? { authDetail: checked.authDetail } : {}),
      receivedAt: receivedAt.toISOString(),
    };
    const summary = {
      session: session.id,
      ip: session.remoteAddress,
      from_domain: domainOf(mailFrom),
      to_domains: [...new Set(envelope.recipients.map(domainOf))],
      bytes: raw.length,
      tls: envelope.tls?.protocol ?? null,
      ...envelope.auth,
    };
    let res: Response;
    let body: unknown;
    try {
      res = await post(
        MX_DELIVER_PATH,
        raw,
        {
          "content-type": "application/octet-stream",
          [MX_ENVELOPE_HEADER]: encodeEnvelopeHeader(envelope),
        },
        deliverTimeoutMs,
      );
      body = await res.json().catch(() => null);
    } catch (err) {
      log("deliver_failed", { ...summary, ms: Date.now() - started, error: err });
      throw smtpError(MX_TEMPORARY_FAILURE);
    }
    if (res.ok) {
      log("delivered", { ...summary, ms: Date.now() - started });
      return `Message accepted (${session.id})`;
    }
    const reply =
      res.status === MX_DELIVER_PERMANENT_STATUS || res.status === MX_DELIVER_TEMPORARY_STATUS
        ? smtpReplySchema.safeParse(body)
        : null;
    if (reply?.success) {
      log("deliver_refused", { ...summary, ms: Date.now() - started, code: reply.data.code });
      throw smtpError(reply.data);
    }
    log("deliver_failed", { ...summary, ms: Date.now() - started, status: res.status });
    throw smtpError(MX_TEMPORARY_FAILURE);
  }

  const smtp = new SMTPServer({
    name: env.hostname,
    size: maxMessageBytes,
    maxClients: env.maxClients,
    socketTimeout: env.socketTimeoutMs,
    // No AUTH: this server never relays. STARTTLS comes back once a keypair loads.
    disabledCommands: ["AUTH", "STARTTLS"],
    disableReverseLookup: true,
    logger: false,
    onConnect(session, callback) {
      const ip = session.remoteAddress;
      const recent = (recentByIp.get(ip) ?? 0) + 1;
      recentByIp.set(ip, recent);
      const open = openByIp.get(ip) ?? 0;
      if (recent > env.connectionsPerIpPerMinute || open >= env.maxConnectionsPerIp) {
        log("connection_refused", { ip, open, recent });
        callback(
          smtpError({
            code: 421,
            enhanced: "4.7.0",
            message: "Too many connections from your address, try again later",
          }),
        );
        return;
      }
      openByIp.set(ip, open + 1);
      const timer = setTimeout(() => {
        for (const connection of smtp.connections as Set<SmtpConnection>) {
          if (connection.id === session.id) {
            connection.send(421, "4.4.2 Session time limit reached, closing connection");
          }
        }
      }, env.sessionTimeoutMs);
      timer.unref();
      sessions.set(session.id, { refused: 0, timer });
      callback();
    },
    onClose(session) {
      const state = sessions.get(session.id);
      if (!state) return;
      sessions.delete(session.id);
      clearTimeout(state.timer);
      state.release?.();
      const open = (openByIp.get(session.remoteAddress) ?? 1) - 1;
      if (open <= 0) openByIp.delete(session.remoteAddress);
      else openByIp.set(session.remoteAddress, open);
    },
    onRcptTo(address, session, callback) {
      checkRecipient(address.address, session).then(
        () => callback(),
        (err) => callback(asReply(err)),
      );
    },
    onData(stream, session, callback) {
      const state = sessions.get(session.id);
      const chunks: Buffer[] = [];
      let held = 0;
      let streamed = 0;
      let starved = false;
      const release = () => {
        buffered -= held;
        held = 0;
        chunks.length = 0;
      };
      if (state) state.release = release;
      // smtp-server flags an oversized message but keeps streaming it in; past
      // the cap, or the budget all sessions share, the rest is drained unkept.
      stream.on("data", (chunk: Buffer) => {
        streamed += chunk.length;
        if (starved || stream.sizeExceeded) return release();
        if (buffered + chunk.length > env.maxBufferedBytes) {
          starved = true;
          return release();
        }
        chunks.push(chunk);
        held += chunk.length;
        buffered += chunk.length;
      });
      stream.once("end", () => {
        // The handoff owns the bytes now: a client hanging up mid-POST must not free them early.
        if (state) delete state.release;
        const receivedAt = new Date();
        let handoff: Promise<string>;
        if (stream.sizeExceeded || starved) {
          log("message_refused", {
            session: session.id,
            ip: session.remoteAddress,
            reason: stream.sizeExceeded ? "size" : "memory",
            bytes: streamed,
          });
        }
        if (stream.sizeExceeded) {
          handoff = Promise.reject(
            smtpError({
              code: 552,
              enhanced: "5.3.4",
              message: "Message size exceeds fixed maximum message size",
            }),
          );
        } else if (starved) {
          handoff = Promise.reject(
            smtpError({
              code: 452,
              enhanced: "4.3.1",
              message: "Insufficient system storage, try again later",
            }),
          );
        } else {
          const raw = Buffer.concat(chunks, held);
          // fetch sends a copy of its body, so a message being handed over is held twice.
          buffered += held;
          held *= 2;
          handoff = deliver(session, raw, receivedAt);
        }
        chunks.length = 0;
        handoff
          .then(
            (message) => callback(null, message),
            (err) => callback(asReply(err)),
          )
          .finally(release);
      });
    },
  });

  smtp.on("error", (err) => {
    log("connection_error", { ip: (err as { remoteAddress?: string }).remoteAddress, error: err });
  });

  function reloadTls(): void {
    if (!env.tls) return;
    const { certPath, keyPath } = env.tls;
    let stamp: string | undefined;
    try {
      stamp = `${statSync(certPath).mtimeMs}:${statSync(keyPath).mtimeMs}`;
      if (stamp === tlsSeen) return;
      const cert = readFileSync(certPath);
      const key = readFileSync(keyPath);
      const leaf = new X509Certificate(cert);
      // A mismatched or half-written pair throws here. updateSecureContext
      // would throw too, but only after dropping the context in use, leaving
      // STARTTLS with no certificate at all.
      createSecureContext({ cert, key });
      smtp.updateSecureContext({ cert, key });
      smtp.options.disabledCommands = ["AUTH"];
      tlsSeen = stamp;
      log("tls_loaded", { subject: leaf.subject, expires: leaf.validTo });
    } catch (err) {
      const problem = `${(err as { code?: string }).code ?? "unusable"} ${stamp ?? ""}`;
      if (problem !== tlsSeen) log("tls_unavailable", { certPath, error: err });
      tlsSeen = problem;
    }
  }

  reloadTls();
  const tlsCheck = setInterval(reloadTls, TLS_CHECK_INTERVAL_MS);
  const minuteTick = setInterval(() => recentByIp.clear(), 60_000);
  tlsCheck.unref();
  minuteTick.unref();

  return {
    smtp,
    reloadTls,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tlsCheck);
        clearInterval(minuteTick);
        smtp.close(() => resolve());
      }),
  };
}
