import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { sniffFileType, sniffImageType } from "./file-type.js";

/**
 * SSRF-guarded HTTP clients: webhook delivery (postJson) and the screening
 * fetch of an email's remote images (getImage). Defenses, in order:
 * - postJson: https only (http allowed solely for loopback targets when the
 *   caller opts in, i.e. local development); getImage: http or https, on
 *   ports 80 and 443 only;
 * - IP-literal hosts validated before any connection;
 * - hostnames resolved through a custom `lookup` that validates the resolved
 *   address and hands THAT address to the socket — validation and connection
 *   use the same single resolution, so DNS rebinding between "check" and
 *   "connect" is impossible by construction;
 * - redirects never followed by the socket: postJson stops at the first
 *   answer, getImage follows a few by hand and validates every hop again;
 * - response reads capped, requests time-boxed.
 */

/** Private/reserved ranges that a delivery URL must never reach. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map(Number);
    const [a = -1, b = -1, c = -1] = parts;
    return (
      a === 0 || // 0.0.0.0/8 ("this network")
      a === 10 || // 10.0.0.0/8
      a === 127 || // 127.0.0.0/8 loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
      (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
      (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
      a >= 224 // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
    );
  }
  if (family === 6) {
    // v4-mapped/embedded forms (::ffff:10.0.0.1) are rejected outright: a
    // legitimately public v4 target arrives as a v4 address, so any v4-in-v6
    // form is only useful as a filter bypass.
    if (ip.includes(".")) return true;
    const words = expandIpv6(ip);
    const firstWord = words[0] ?? 0;
    return (
      isIpv6Loopback(ip) || // ::1 and :: (unspecified)
      isEmbeddedIpv4(words) || // ::ffff:7f00:1, ::ffff:0:7f00:1, ::7f00:1, NAT64 and 6to4
      (firstWord === 0x100 && words.slice(1, 4).every((word) => word === 0)) || // 100::/64 discard-only
      (firstWord === 0x2001 && words[1] === 0) || // 2001::/32 Teredo (tunnels to an embedded v4)
      (firstWord === 0x2001 && words[1] === 0x0db8) || // 2001:db8::/32 documentation
      (firstWord & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (firstWord & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (firstWord & 0xffc0) === 0xfec0 || // fec0::/10 deprecated site-local
      (firstWord & 0xff00) === 0xff00 // ff00::/8 multicast
    );
  }
  return true; // not an IP at all — never connect
}

function isIpv6Loopback(ip: string): boolean {
  const words = expandIpv6(ip);
  return words.slice(0, 7).every((w) => w === 0) && (words[7] === 0 || words[7] === 1);
}

function isEmbeddedIpv4(words: number[]): boolean {
  const firstFourZero = words.slice(0, 4).every((word) => word === 0);
  const compatibleOrMapped =
    firstFourZero && words[4] === 0 && (words[5] === 0 || words[5] === 0xffff);
  // ::ffff:0:0/96 (SIIT "IPv4-translated", deprecated but still parsed).
  const translated = firstFourZero && words[4] === 0xffff && words[5] === 0;
  const nat64WellKnown =
    words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  const nat64Local = words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1;
  const sixToFour = words[0] === 0x2002;
  return compatibleOrMapped || translated || nat64WellKnown || nat64Local || sixToFour;
}

function expandIpv6(ip: string): number[] {
  const [headRaw = "", tailRaw = ""] = ip.split("::");
  const head = headRaw ? headRaw.split(":").map((g) => Number.parseInt(g, 16)) : [];
  const tail = tailRaw ? tailRaw.split(":").map((g) => Number.parseInt(g, 16)) : [];
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

const LOOPBACK_V4 = /^127\./;

function isLoopbackIp(ip: string): boolean {
  return LOOPBACK_V4.test(ip) || isIpv6Loopback(ip);
}

/**
 * A DNS lookup that validates what it resolves and hands THAT address to the
 * socket: validation and connection use the same single resolution, the pin
 * that makes rebinding impossible. The socket calls this with `all: true`
 * when autoSelectFamily is on (the Node ≥20 default) and expects an address
 * ARRAY back then; answering with a single address there makes net throw
 * "Invalid IP address: undefined", killing every request to a hostname.
 */
function pinnedLookup(allowIp: (ip: string) => boolean, label: string): typeof dnsLookup {
  return ((
    host: string,
    options: { all?: boolean },
    cb: (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, "", 0);
      const blocked = addresses.find((a) => !allowIp(a.address));
      if (blocked) return cb(new Error(`${label} resolves to a blocked address`), "", 0);
      const first = addresses[0];
      if (!first) return cb(new Error(`${label} did not resolve`), "", 0);
      // Every returned address was validated above, so whichever one the
      // socket picks stays inside the guard.
      if (options?.all === true) return cb(null, addresses);
      cb(null, first.address, first.family);
    });
  }) as typeof dnsLookup;
}

export interface PostJsonOptions {
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Development escape hatch: permit http and loopback targets. */
  allowLocalhost?: boolean;
}

export interface PostJsonResult {
  status: number;
  /** Response body, truncated to maxResponseBytes. */
  body: string;
  /** The receiver's Retry-After header, verbatim, when it sent one. */
  retryAfter?: string;
}

export type PostFailureCode =
  | "url_rejected"
  | "dns_failed"
  | "connection_refused"
  | "connection_reset"
  | "timeout"
  | "tls_failed"
  | "delivery_failed";

/**
 * Folds a postJson rejection into a fixed code. Anything persisted or shown
 * for a user-chosen target must go through this: raw socket/TLS messages
 * would tell the caller more about the host than a status code does.
 */
export function postFailureCode(err: unknown): PostFailureCode {
  const e = err as { name?: string; code?: string; message?: string };
  const message = e.message ?? "";
  const code = e.code ?? "";
  if (message.startsWith("webhook url")) return "url_rejected";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ECONNRESET" || code === "EPIPE") return "connection_reset";
  if (code === "ETIMEDOUT" || e.name === "TimeoutError" || e.name === "AbortError")
    return "timeout";
  if (code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || /certificate|SSL/i.test(message)) {
    return "tls_failed";
  }
  return "delivery_failed";
}

// Short on purpose: a receiver that stalls holds a delivery worker for the
// whole window, and every retry pays it again.
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024;

/**
 * POST a JSON body to an untrusted, user-supplied URL. Rejects (never
 * requests) on scheme or address violations; resolves with the response
 * status for any completed HTTP exchange, 2xx or not.
 */
export async function postJson(rawUrl: string, opts: PostJsonOptions): Promise<PostJsonResult> {
  const allowLocalhost = opts.allowLocalhost ?? false;
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowLocalhost)) {
    throw new Error(`webhook url must be https: ${url.protocol}//`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const allowIp = (ip: string): boolean =>
    allowLocalhost && isLoopbackIp(ip) ? true : !isBlockedIp(ip);
  // IP-literal hosts bypass DNS (and therefore the lookup hook below):
  // validate them up front.
  if (isIP(hostname) !== 0 && !allowIp(hostname)) {
    throw new Error(`webhook url resolves to a blocked address`);
  }

  const lookup = pinnedLookup(allowIp, "webhook url");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<PostJsonResult>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        lookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const finish = (): void => {
          const retryAfter = res.headers["retry-after"];
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ...(typeof retryAfter === "string" ? { retryAfter } : {}),
          });
        };
        res.on("data", (chunk: Buffer) => {
          if (received >= maxBytes) return;
          chunks.push(chunk.subarray(0, maxBytes - received));
          received += chunk.length;
          if (received >= maxBytes) {
            // Cap reached: stop reading; the status is already known.
            finish();
            res.destroy();
          }
        });
        res.on("end", finish);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** Bedrock's per-image limit; a bigger image is refused, never cut. */
export const IMAGE_FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 3_000;
const IMAGE_FETCH_MAX_REDIRECTS = 3;
const IMAGE_FETCH_PORTS = new Set([80, 443]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// A desktop browser's: some hosts show an honest client a decoy image.
const IMAGE_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export interface GetImageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Aborts with the caller, e.g. an email's whole fetch budget. */
  signal?: AbortSignal;
  /** Tests and local development: permit loopback targets, on any port. */
  allowLocalhost?: boolean;
}

export interface FetchedImage {
  bytes: Buffer;
  /** The declared type, lowercased and without parameters; the bytes agree with it. */
  contentType: string;
}

type Hop = { redirect: string } | { status: number; contentType: string; bytes: Buffer };

function requestHop(
  url: URL,
  allowIp: (ip: string) => boolean,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Hop> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<Hop>((resolve, reject) => {
    // No cookie and no Referer: the request carries nothing about who asks.
    const req = transport.request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": IMAGE_FETCH_USER_AGENT,
          accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
          "accept-encoding": "identity",
        },
        lookup: pinnedLookup(allowIp, "image url"),
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECTS.has(status) && location) {
          res.resume();
          resolve({ redirect: location });
          return;
        }
        if (Number(res.headers["content-length"]) > maxBytes) {
          res.destroy();
          reject(new Error(`image url is over ${maxBytes} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            reject(new Error(`image url is over ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status,
            contentType:
              (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
            bytes: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET one image an email shows, for screening. Rejects (and never connects
 * for) a blocked address or port; follows up to three redirects, validating
 * each hop the same way; refuses, rather than truncates, anything over the
 * cap; and accepts the answer only when its image/* type and its leading
 * bytes both say image.
 */
export async function getImage(rawUrl: string, opts: GetImageOptions = {}): Promise<FetchedImage> {
  const maxBytes = opts.maxBytes ?? IMAGE_FETCH_MAX_BYTES;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const allowIp = (ip: string): boolean =>
    opts.allowLocalhost && isLoopbackIp(ip) ? true : !isBlockedIp(ip);
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`image url must be http or https: ${url.protocol}//`);
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const loopback = opts.allowLocalhost === true && isIP(hostname) !== 0 && isLoopbackIp(hostname);
    if (!IMAGE_FETCH_PORTS.has(port) && !loopback) {
      throw new Error(`image url port must be 80 or 443: ${port}`);
    }
    if (isIP(hostname) !== 0 && !allowIp(hostname)) {
      throw new Error("image url resolves to a blocked address");
    }
    const answer = await requestHop(url, allowIp, maxBytes, signal);
    if ("redirect" in answer) {
      if (hop >= IMAGE_FETCH_MAX_REDIRECTS) throw new Error("image url redirects too many times");
      url = new URL(answer.redirect, url);
      continue;
    }
    if (answer.status !== 200) throw new Error(`image url answered ${answer.status}`);
    const svg = answer.contentType === "image/svg+xml";
    const agrees = svg
      ? sniffFileType(answer.bytes) === "svg"
      : answer.contentType.startsWith("image/") && sniffImageType(answer.bytes) !== null;
    if (!agrees)
      throw new Error(`image url served something other than ${answer.contentType || "an image"}`);
    return { bytes: answer.bytes, contentType: answer.contentType };
  }
}
