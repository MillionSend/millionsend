import {
  MAX_DELIVER_RECIPIENTS,
  MX_INGEST_SECRET_MIN_LENGTH,
} from "@millionsend/core/receiving-protocol";

/**
 * The MX parses its own environment rather than importing @millionsend/config:
 * that module validates the app's variables (DATABASE_URL,
 * MASTER_ENCRYPTION_KEY, ...) when it is imported, and this process holds no
 * database and no keys. It boots with nothing but the MX_* variables below.
 */
export interface MxEnv {
  /** MX_INGEST_URL without a trailing slash: the app's internal MX API base. */
  ingestUrl: string;
  ingestSecret: string;
  /** MX_HOSTNAME: the greeting banner and EHLO name. */
  hostname: string;
  port: number;
  /** STARTTLS keypair paths; the files may appear later (certbot), so existence is checked at use. */
  tls: { certPath: string; keyPath: string } | null;
  maxClients: number;
  maxConnectionsPerIp: number;
  connectionsPerIpPerMinute: number;
  maxRecipients: number;
  /** Inactivity before a session is dropped (smtp-server socketTimeout). */
  socketTimeoutMs: number;
  /** Longest a single session may last, however busy. */
  sessionTimeoutMs: number;
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type Source = Record<string, string | undefined>;

/** Throws one error naming every invalid variable, so a misconfigured box fails at boot. */
export function parseMxEnv(source: Source): MxEnv {
  const problems: string[] = [];
  const value = (key: string) => {
    const v = source[key]?.trim();
    return v ? v : undefined;
  };
  const int = (key: string, fallback: number, min: number, max: number) => {
    const raw = value(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };

  const ingestUrl = value("MX_INGEST_URL");
  let url: URL | null = null;
  try {
    url = ingestUrl ? new URL(ingestUrl) : null;
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    problems.push("MX_INGEST_URL must be an http(s) URL");
  } else if (url.username || url.password || url.search || url.hash) {
    problems.push("MX_INGEST_URL must not carry credentials, a query or a fragment");
  }
  const ingestSecret = value("MX_INGEST_SECRET") ?? "";
  if (ingestSecret.length < MX_INGEST_SECRET_MIN_LENGTH) {
    problems.push(`MX_INGEST_SECRET must be at least ${MX_INGEST_SECRET_MIN_LENGTH} characters`);
  }
  const hostname = value("MX_HOSTNAME")?.toLowerCase() ?? "";
  if (!HOSTNAME_RE.test(hostname)) {
    problems.push("MX_HOSTNAME must be a fully qualified hostname");
  }
  const certPath = value("MX_TLS_CERT_PATH");
  const keyPath = value("MX_TLS_KEY_PATH");
  if (Boolean(certPath) !== Boolean(keyPath)) {
    problems.push("MX_TLS_CERT_PATH and MX_TLS_KEY_PATH must be set together");
  }

  const env: MxEnv = {
    ingestUrl: url ? url.href.replace(/\/+$/, "") : "",
    ingestSecret,
    hostname,
    port: int("MX_PORT", 2525, 1, 65535),
    tls: certPath && keyPath ? { certPath, keyPath } : null,
    maxClients: int("MX_MAX_CLIENTS", 200, 1, 10_000),
    maxConnectionsPerIp: int("MX_MAX_CONNECTIONS_PER_IP", 10, 1, 1000),
    connectionsPerIpPerMinute: int("MX_CONNECTIONS_PER_IP_PER_MINUTE", 60, 1, 10_000),
    maxRecipients: int("MX_MAX_RECIPIENTS", 50, 1, MAX_DELIVER_RECIPIENTS),
    socketTimeoutMs: int("MX_SOCKET_TIMEOUT_MS", 60_000, 1000, 3_600_000),
    sessionTimeoutMs: int("MX_SESSION_TIMEOUT_MS", 600_000, 10_000, 86_400_000),
  };
  if (problems.length > 0) throw new Error(`mx: invalid configuration: ${problems.join("; ")}`);
  return env;
}
