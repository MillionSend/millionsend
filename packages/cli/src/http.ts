import type { Logger } from "./log.js";
import { sleep } from "./utils.js";

/** 401/403 from either side: a hard stop, never retried, never routed around. */
export class AuthError extends Error {
  readonly status: number;
  constructor(side: string, status: number) {
    super(`${side} rejected the API key (${status})`);
    this.name = "AuthError";
    this.status = status;
  }
}

/** Any other failed request: the API's error body (name/message) plus the status; status 0 is a network failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, name: string, message: string, body: unknown = null) {
    super(message);
    this.name = name;
    this.status = status;
    this.body = body;
  }
}

/**
 * A cursor walk that stopped moving: the server answered the same page for a
 * new `after`, or the walk ran past MAX_PAGES. Thrown instead of looping
 * forever on duplicates; the list is never silently truncated.
 */
export class PaginationError extends Error {
  constructor(path: string, after: string | undefined, reason: string) {
    super(`${path}: ${reason} (cursor after=${after ?? "none"})`);
    this.name = "PaginationError";
  }
}

export const MAX_PAGES = 100_000;

/**
 * One check per page of a cursor walk. A server that ignores `after` hands the
 * first page back forever; every page must move the cursor and bring new ids.
 */
export function cursorGuard(
  path: string,
  maxPages = MAX_PAGES,
): (page: readonly { id: string }[], after: string | undefined) => void {
  const seen = new Set<string>();
  let pages = 0;
  return (page, after) => {
    pages += 1;
    if (pages > maxPages) {
      throw new PaginationError(path, after, `more than ${maxPages} pages walked`);
    }
    if (page.length > 0 && page[page.length - 1]?.id === after) {
      throw new PaginationError(
        path,
        after,
        "the page ends at the cursor it was asked to start after; the API ignored `after`",
      );
    }
    if (page.length > 0 && page.every((row) => seen.has(row.id))) {
      throw new PaginationError(path, after, "the page holds only ids already listed");
    }
    for (const row of page) seen.add(row.id);
  };
}

export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined> | undefined;
  headers?: Record<string, string> | undefined;
}

export interface Http {
  get<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>>;
}

/** What createHttp returns: the request methods plus the pacing controls the session uses. */
export interface HttpClient extends Http {
  /** The last `ratelimit-limit` header seen (Resend: requests per second per team); null until a response carries one. */
  readonly rateLimit: number | null;
  /** Re-paces the client; the header-driven throttle keeps applying on top. */
  setRps(rps: number): void;
}

export interface HttpOptions {
  baseUrl: string;
  token: string;
  userAgent: string;
  /**
   * Requests per second; a request starts at most every 1000/rps ms. A 429
   * halves the effective rate, which climbs back one req/s per clean second.
   */
  rps: number;
  /** Attempts for 5xx and network failures (backoff 1s, 2s, 4s, 8s). */
  maxAttempts?: number | undefined;
  /** Attempts for 429 (wait per retry-after / ratelimit-reset, 2s without either). */
  rateLimitAttempts?: number | undefined;
  log: Logger;
  /** Names the side in messages: "Resend" / "MillionSend". */
  name: string;
  /** Refuse every non-GET method — the guarantee that the source is never written. */
  readOnly?: boolean | undefined;
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
}

const MAX_WAIT_MS = 120_000;
/**
 * Requests left in the window at which acquire() waits for the reset. The
 * window is the team's, shared with its production sending, so the last
 * slots are left to the app rather than spent here.
 */
const REMAINING_RESERVE = 2;

const clampWait = (ms: number): number => Math.min(MAX_WAIT_MS, Math.max(0, ms));

/** A numeric header, or null when absent or not a number. */
function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Milliseconds to wait per `retry-after` (seconds or HTTP date) or `ratelimit-reset` (seconds); null without either. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return clampWait(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return clampWait(date - now);
  }
  const reset = headerNumber(headers, "ratelimit-reset");
  return reset === null ? null : clampWait(reset * 1000);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

/**
 * Node's fetch rejects with a bare `TypeError: fetch failed`; the DNS/TCP/TLS
 * reason (ECONNREFUSED 10.0.0.5:3000, ENOTFOUND, self-signed certificate) sits
 * in `cause`.
 */
export function networkReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown }).cause as
    | { code?: unknown; message?: unknown; address?: unknown; port?: unknown }
    | null
    | undefined;
  if (cause === null || cause === undefined) return message;
  let detail: string | null = null;
  if (typeof cause.code === "string") {
    const where =
      typeof cause.address === "string"
        ? ` ${cause.address}${cause.port === undefined ? "" : `:${String(cause.port)}`}`
        : "";
    detail = `${cause.code}${where}`;
  } else if (typeof cause.message === "string") {
    detail = cause.message;
  }
  return detail === null ? message : `${message} (${detail})`;
}

const isPlanLimit = (body: unknown): boolean =>
  (body as { name?: unknown } | null)?.name === "plan_limit_reached";

export function createHttp(options: HttpOptions): HttpClient {
  const {
    name,
    log,
    maxAttempts = 5,
    rateLimitAttempts = 8,
    timeoutMs = 30_000,
    fetch: fetchFn = globalThis.fetch,
  } = options;
  const base = options.baseUrl.replace(/\/+$/, "");
  let targetRps = options.rps;
  let rps = targetRps;
  let rampedAt = 0;
  let nextSlot = 0;
  let holdUntil = 0;
  let rateLimit: number | null = null;

  /** The effective rate: recovers one req/s per second since the last 429 (or step) until it meets the target. */
  const currentRps = (now: number): number => {
    if (rps < targetRps) {
      const steps = Math.floor((now - rampedAt) / 1000);
      if (steps > 0) {
        rps = Math.min(targetRps, rps + steps);
        rampedAt += steps * 1000;
      }
    }
    return rps;
  };
  const acquire = async (): Promise<void> => {
    const now = Date.now();
    const at = Math.max(now, nextSlot, holdUntil);
    nextSlot = at + 1000 / currentRps(now);
    if (at > now) await sleep(at - now);
  };
  const readRateHeaders = (headers: Headers): void => {
    const limit = headerNumber(headers, "ratelimit-limit");
    if (limit !== null && limit > 0) rateLimit = limit;
    const remaining = headerNumber(headers, "ratelimit-remaining");
    const reset = headerNumber(headers, "ratelimit-reset");
    if (remaining !== null && reset !== null && remaining <= REMAINING_RESERVE) {
      holdUntil = Math.max(holdUntil, Date.now() + clampWait(reset * 1000));
    }
  };

  async function request<T>(
    method: string,
    path: string,
    body: unknown,
    { query, headers: extraHeaders }: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    if (options.readOnly === true && method !== "GET") {
      throw new Error(`${name} is read-only for this tool; refusing ${method} ${path}`);
    }
    const url = new URL(base + (path.startsWith("/") ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const label = `${method} ${url.pathname}${url.search}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      "user-agent": options.userAgent,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    };
    const init: RequestInit = {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    let rateLimited = 0;
    let failures = 0;
    for (;;) {
      await acquire();
      const started = Date.now();
      let response: Response;
      try {
        response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        const reason = networkReason(error);
        failures += 1;
        if (failures >= maxAttempts) {
          const hint =
            name === "MillionSend"
              ? "check --to-url / MILLIONSEND_BASE_URL"
              : `check your network to ${url.host}`;
          throw new ApiError(
            0,
            "network_error",
            `${name}: ${label} failed ${failures} times — ${reason}; ${hint}`,
          );
        }
        const wait = 1000 * 2 ** (failures - 1);
        log.warn(`retry ${failures + 1}/${maxAttempts} in ${seconds(wait)} — ${name} ${reason}`);
        await sleep(wait);
        continue;
      }
      log.debug(`${label} → ${response.status} (${Date.now() - started} ms)`);
      readRateHeaders(response.headers);
      const parsed = await parseBody(response);
      const { status } = response;
      // 403 is a key problem except when the API names a plan limit (a domain past the plan's cap).
      if (status === 401 || (status === 403 && !isPlanLimit(parsed))) {
        throw new AuthError(name, status);
      }
      if (status === 429) {
        rateLimited += 1;
        if (rateLimited >= rateLimitAttempts) {
          throw new ApiError(
            429,
            "rate_limit_exceeded",
            `${name} kept rate limiting ${label} after ${rateLimited} attempts`,
            parsed,
          );
        }
        const wait = retryAfterMs(response.headers) ?? 2000;
        rps = Math.max(1, rps / 2);
        rampedAt = Date.now();
        log.warn(
          `retry ${rateLimited + 1}/${rateLimitAttempts} in ${seconds(wait)} — ${name} 429 · slowing to ${Math.round(rps * 10) / 10} req/s`,
        );
        await sleep(wait);
        continue;
      }
      if (status >= 500) {
        failures += 1;
        if (failures >= maxAttempts) {
          throw new ApiError(
            status,
            "server_error",
            `${name} answered ${status} to ${label} ${failures} times`,
            parsed,
          );
        }
        const wait = 1000 * 2 ** (failures - 1);
        log.warn(`retry ${failures + 1}/${maxAttempts} in ${seconds(wait)} — ${name} ${status}`);
        await sleep(wait);
        continue;
      }
      if (status >= 400) {
        const error = (parsed ?? {}) as { name?: unknown; message?: unknown };
        throw new ApiError(
          status,
          typeof error.name === "string" ? error.name : "http_error",
          typeof error.message === "string"
            ? `${name}: ${error.message} (${status} on ${label})`
            : `${name} answered ${status} to ${label}`,
          parsed,
        );
      }
      return { status, body: parsed as T, headers: response.headers };
    }
  }

  return {
    get rateLimit() {
      return rateLimit;
    },
    setRps(next) {
      // An unthrottled client follows the new target; one recovering from a 429 keeps climbing towards it.
      rps = rps >= targetRps ? next : Math.min(rps, next);
      targetRps = next;
    },
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
    patch: (path, body, options) => request("PATCH", path, body, options),
    delete: (path, options) => request("DELETE", path, undefined, options),
  };
}
