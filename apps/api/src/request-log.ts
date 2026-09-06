/**
 * Request-log body handling. Both bodies of every logged request are stored
 * so the dashboard can act as a request inspector, but redacted at the API
 * boundary: the emails table encrypts content at rest and this log must not
 * become its plaintext copy, so content fields become size markers, secrets
 * become "[redacted]", oversized payloads become a truncation marker, and
 * headers are never stored. Everything else (addresses, names, ids,
 * properties) stays — that is the log's purpose.
 */

export const LOGGED_JSON_MAX_BYTES = 64 * 1024;
/** Above this declared size a body is never read back for the log; the marker carries the size. */
export const LOGGED_BODY_READ_MAX_BYTES = 1024 * 1024;

const CONTENT_KEYS = new Set(["html", "text"]);
const SECRET_KEYS = new Set(["token", "secret", "password"]);
const JSON_CONTENT_TYPE = /\bjson\b/i;

export function maskEmailPathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Not percent-encoded; the raw segment is what gets inspected.
      }
      return decoded.includes("@") ? "[email]" : segment;
    })
    .join("/");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

function contentMarker(kind: string, value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `[${kind}, ${formatBytes(Buffer.byteLength(text, "utf8"))}]`;
}

/**
 * Deep copy of a JSON body with content fields replaced by "[kind, size]"
 * markers and secrets by "[redacted]". `path` is the request path: a
 * preferences-link response's `url` is a capability URL, so it is a secret
 * there and a plain value everywhere else.
 */
export function redactLoggedBody(path: string, value: unknown): unknown {
  const urlIsSecret = path.endsWith("/preferences-link");
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const isAttachment = "filename" in node;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(node)) {
      if (v == null) out[key] = v;
      else if (CONTENT_KEYS.has(key)) out[key] = contentMarker(key, v);
      else if (isAttachment && key === "content") out[key] = contentMarker("attachment content", v);
      else if (SECRET_KEYS.has(key) || key.endsWith("_secret") || (urlIsSecret && key === "url"))
        out[key] = "[redacted]";
      else out[key] = walk(v);
    }
    return out;
  };
  return walk(value);
}

/** Oversized (or unserializable) payloads store a marker instead of the JSON. */
export function capLoggedJson(value: unknown): unknown {
  if (value == null) return null;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    return bytes > LOGGED_JSON_MAX_BYTES ? { truncated: true, bytes } : value;
  } catch {
    return null;
  }
}

/**
 * One side's loggable body: null unless it is JSON, a size-only marker when
 * the declared length is over the read guard (`read` is never called, so a
 * multi-megabyte upload is not re-serialized), otherwise redacted and capped.
 * A failing read logs null rather than failing the caller.
 */
export async function loggedBody(
  path: string,
  contentType: string | null | undefined,
  contentLength: string | null | undefined,
  read: () => Promise<unknown>,
): Promise<unknown> {
  if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) return null;
  const declared = contentLength == null ? null : Number(contentLength);
  if (declared !== null && declared > LOGGED_BODY_READ_MAX_BYTES) {
    return { truncated: true, bytes: declared };
  }
  let body: unknown;
  try {
    body = await read();
  } catch {
    return null;
  }
  return capLoggedJson(redactLoggedBody(path, body));
}
