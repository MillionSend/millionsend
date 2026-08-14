import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * SSRF-guarded HTTP client for webhook delivery. Defenses, in order:
 * - https only (http allowed solely for loopback targets when the caller
 *   opts in, i.e. local development);
 * - IP-literal hosts validated before any connection;
 * - hostnames resolved through a custom `lookup` that validates the resolved
 *   address and hands THAT address to the socket — validation and connection
 *   use the same single resolution, so DNS rebinding between "check" and
 *   "connect" is impossible by construction;
 * - redirects never followed (bare http(s).request has no redirect logic);
 * - response reads capped, requests time-boxed.
 */

/** Private/reserved ranges that a delivery URL must never reach. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map(Number);
    const [a = -1, b = -1] = parts;
    return (
      a === 0 || // 0.0.0.0/8 ("this network")
      a === 10 || // 10.0.0.0/8
      a === 127 || // 127.0.0.0/8 loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) // 192.168.0.0/16
    );
  }
  if (family === 6) {
    // v4-mapped/embedded forms (::ffff:10.0.0.1) are rejected outright: a
    // legitimately public v4 target arrives as a v4 address, so any v4-in-v6
    // form is only useful as a filter bypass.
    if (ip.includes(".")) return true;
    const firstWord = ipv6FirstWord(ip);
    return (
      isIpv6Loopback(ip) || // ::1 and :: (unspecified)
      (firstWord & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (firstWord & 0xffc0) === 0xfe80 // fe80::/10 link-local
    );
  }
  return true; // not an IP at all — never connect
}

function ipv6FirstWord(ip: string): number {
  const head = ip.split("::")[0] ?? "";
  const group = head.split(":")[0];
  if (!group) return 0; // leading "::" — first group is zero
  return Number.parseInt(group, 16);
}

function isIpv6Loopback(ip: string): boolean {
  const words = expandIpv6(ip);
  return words.slice(0, 7).every((w) => w === 0) && (words[7] === 0 || words[7] === 1);
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
}

const DEFAULT_TIMEOUT_MS = 10_000;
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

  // Validation happens inside the lookup and the validated address is the one
  // the socket connects to — the pin that makes rebinding impossible.
  const pinnedLookup: typeof dnsLookup = ((
    host: string,
    _options: object,
    cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, "", 0);
      const blocked = addresses.find((a) => !allowIp(a.address));
      if (blocked) {
        return cb(new Error(`webhook url resolves to a blocked address`), "", 0);
      }
      const first = addresses[0];
      if (!first) return cb(new Error("webhook url did not resolve"), "", 0);
      cb(null, first.address, first.family);
    });
  }) as typeof dnsLookup;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<PostJsonResult>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        lookup: pinnedLookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const finish = (): void => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
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
