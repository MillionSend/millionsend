/**
 * Local end-to-end run of inbound mail, as close to production as one machine
 * gets: Postgres in Docker; the api, worker and mx processes started the way
 * the image starts them (scripts/start.mjs with PROCESS=...); the MX on a high
 * port with a self-signed certificate and nothing but its MX_* variables; real
 * SMTP into it; assertions through the HTTP API with the official `resend`
 * SDK; email.received webhooks to a local HTTPS receiver.
 *
 * The stack runs as the cloud does (IS_CLOUD=true), so plan quotas apply. AWS
 * is a local fake (SES v2 and KMS behind AWS_ENDPOINT_URL, dummy credentials,
 * no shared config files), so nothing reaches a real account and forwarded
 * mail is captured instead of sent.
 *
 *   pnpm exec tsx scripts/e2e/receiving/run.mts
 *
 * Needs Docker, openssl and an installed workspace. Ports 55432, 43101, 43102,
 * 42525, 44566 and 44443 must be free. E2E_OUT=<dir> chooses where logs and
 * report.json go. Exits 0 only when every case passed.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateApiKey } from "../../../packages/core/src/api-keys.js";
import { QUOTA_TOLERANCE, teamQuota } from "../../../packages/core/src/plans.js";
import {
  deriveReceivedDownloadKey,
  signReceivedDownload,
} from "../../../packages/core/src/receiving/downloads.js";
import { MAX_RECEIVED_MESSAGE_BYTES } from "../../../packages/core/src/receiving/protocol.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// This directory is no workspace package: dependencies resolve from the
// packages that declare them.
async function load(fromPackage: string, id: string) {
  const resolved = createRequire(join(root, fromPackage, "package.json")).resolve(id);
  return import(pathToFileURL(resolved).href);
}
const resendModule = await load("apps/api", "resend");
const Resend = resendModule.Resend ?? resendModule.default.Resend;
const nodemailer = await load("apps/api", "nodemailer");
const createTransport = nodemailer.createTransport ?? nodemailer.default.createTransport;
const mailparser = await load("packages/core", "mailparser");
const simpleParser = mailparser.simpleParser ?? mailparser.default.simpleParser;
const postgres = (await load("packages/db", "postgres")).default;

// The SDK prints every API error it returns outside production; refusals here are expected.
process.env.NODE_ENV = "production";
const run = randomBytes(4).toString("hex");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: run by hand, never under turbo
const out = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "ms-recv-e2e-"));
mkdirSync(out, { recursive: true });

const PORTS = { pg: 55432, api: 43101, api2: 43102, mx: 42525, aws: 44566, hooks: 44443 };
const API = `http://127.0.0.1:${PORTS.api}`;
const MX_HOST = "mx.millionsend-dns.com";
const PG_CONTAINER = "ms-recv-e2e-pg";
const DATABASE_URL = `postgres://millionsend:e2e@127.0.0.1:${PORTS.pg}/millionsend`;
const KMS_KEY_ID = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-4000-8000-0000000e2e00";

const A_RECV = "inbound.team-a.example";
const A_SEND = "team-a.example";
const B_RECV = "inbound.team-b.example";
const F_RECV = "inbound.team-f.example";
const F_RECV2 = "inbound2.team-f.example";
const SENDER = "sender.e2e.example";
const BOUNCE = `bounce@${SENDER}`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG2 = Buffer.concat([PNG, Buffer.from(`e2e-${run}`)]);
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n% ${run}\n%%EOF\n`);
const CANARY_BODY = `CANARY-BODY-${run}`;
const CANARY_SUBJECT = `CANARY-SUBJECT-${run}`;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const msgId = (label: string) => `<${label}.${run}@${SENDER}>`;
/** A message as the MX stores it: the client may have added the CRLF that ends DATA. */
const sameMessage = (stored: Buffer, sent: Buffer) =>
  stored.equals(sent) || stored.equals(Buffer.concat([sent, Buffer.from("\r\n")]));

async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// --- TLS material ---------------------------------------------------------

function selfSigned(name: string, cn: string, san: string) {
  const key = join(out, `${name}.key`);
  const cert = join(out, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      `/CN=${cn}`,
      "-addext",
      `subjectAltName=${san}`,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "pipe" },
  );
  return { key, cert, pem: readFileSync(cert) };
}
const mxTls = selfSigned("mx", MX_HOST, `DNS:${MX_HOST}`);
const hookTls = selfSigned("hooks", "127.0.0.1", "IP:127.0.0.1,DNS:localhost");
const emptyAwsConfig = join(out, "aws-empty");
writeFileSync(emptyAwsConfig, "");

// --- fake AWS (SES v2 + KMS) and the webhook receiver ----------------------

interface SesCapture {
  raw: Buffer;
  tags: Record<string, string>;
}
const sesSends: SesCapture[] = [];
const awsUnexpected: string[] = [];
const sortedJson = (value: Record<string, string> | null | undefined) =>
  JSON.stringify(Object.entries(value ?? {}).sort());

const fakeAws = createServer(async (req, res) => {
  const body = await readBody(req);
  const target = String(req.headers["x-amz-target"] ?? "");
  const reply = (status: number, payload: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(JSON.stringify(payload));
  };
  const kms = (status: number, payload: unknown) =>
    reply(status, payload, "application/x-amz-json-1.1");
  if (target === "TrentService.Encrypt") {
    const p = JSON.parse(body.toString());
    // The blob carries its plaintext and context, so any process can unwrap
    // it, but only with the same EncryptionContext, as real KMS insists.
    const blob = Buffer.from(
      `e2e-kms:${JSON.stringify({ c: sortedJson(p.EncryptionContext), k: p.Plaintext })}`,
    );
    return kms(200, {
      CiphertextBlob: blob.toString("base64"),
      KeyId: KMS_KEY_ID,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    });
  }
  if (target === "TrentService.Decrypt") {
    const p = JSON.parse(body.toString());
    const blob = Buffer.from(p.CiphertextBlob, "base64").toString();
    const sealed = blob.startsWith("e2e-kms:") ? JSON.parse(blob.slice(8)) : null;
    if (!sealed || sealed.c !== sortedJson(p.EncryptionContext)) {
      awsUnexpected.push(`KMS Decrypt refused (context ${sortedJson(p.EncryptionContext)})`);
      return kms(400, { __type: "InvalidCiphertextException", message: "context mismatch" });
    }
    return kms(200, { Plaintext: sealed.k, KeyId: KMS_KEY_ID });
  }
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (req.method === "GET" && path === "/v2/email/account") {
    return reply(200, {
      SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 0 },
      SendingEnabled: true,
      ProductionAccessEnabled: true,
      EnforcementStatus: "HEALTHY",
    });
  }
  if (req.method === "POST" && path === "/v2/email/outbound-emails") {
    const p = JSON.parse(body.toString());
    const raw = Buffer.from(p.Content?.Raw?.Data ?? "", "base64");
    writeFileSync(join(out, `ses-${sesSends.length + 1}.eml`), raw);
    sesSends.push({
      raw,
      tags: Object.fromEntries(
        (p.EmailTags ?? []).map((t: { Name: string; Value: string }) => [t.Name, t.Value]),
      ),
    });
    return reply(200, { MessageId: `e2e-ses-${sesSends.length}` });
  }
  if (req.method === "GET" && path.startsWith("/v2/email/identities/")) {
    return reply(200, {
      IdentityType: "DOMAIN",
      VerifiedForSendingStatus: true,
      VerificationStatus: "SUCCESS",
      DkimAttributes: { SigningEnabled: true, Status: "SUCCESS" },
      MailFromAttributes: { MailFromDomainStatus: "SUCCESS" },
    });
  }
  awsUnexpected.push(`${req.method} ${path} ${target}`.trim());
  return reply(400, { __type: "UnsupportedOperation", message: "e2e fake AWS" });
});

interface Hook {
  team: string;
  headers: IncomingMessage["headers"];
  body: string;
}
const hooks: Hook[] = [];
const hookServer = createHttpsServer(
  { key: readFileSync(hookTls.key), cert: hookTls.pem },
  async (req, res) => {
    const body = (await readBody(req)).toString("utf8");
    hooks.push({ team: (req.url ?? "").split("/").pop() ?? "", headers: req.headers, body });
    res.writeHead(200).end();
  },
);
const hookData = (h: Hook) => JSON.parse(h.body).data as Record<string, unknown>;
const hooksFor = (emailId: string) => hooks.filter((h) => hookData(h).email_id === emailId);

// --- the stack ---------------------------------------------------------------

const baseEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? tmpdir(),
  TMPDIR: tmpdir(),
};
const ingestSecret = randomBytes(32).toString("hex");
const masterKey = randomBytes(32);
const appEnv: Record<string, string> = {
  ...baseEnv,
  NODE_ENV: "production",
  DATABASE_URL,
  MASTER_ENCRYPTION_KEY: masterKey.toString("base64"),
  IS_CLOUD: "true",
  KMS_KEY_ID,
  STRIPE_SECRET_KEY: "sk_test_e2e_local_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_e2e_local_fake",
  APP_BASE_URL: "http://127.0.0.1:43100",
  PUBLIC_API_URL: API,
  PORT: String(PORTS.api),
  RECEIVING_MX_HOST: MX_HOST,
  MX_INGEST_SECRET: ingestSecret,
  WEBHOOK_ALLOW_LOCALHOST: "true",
  WARMUP_ENABLED: "false",
  SES_TENANTS: "false",
  ABUSE_JUDGE: "off",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "e2e-local-fake-access-key",
  AWS_SECRET_ACCESS_KEY: "e2e-local-fake-secret",
  AWS_ENDPOINT_URL: `http://127.0.0.1:${PORTS.aws}`,
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_SHARED_CREDENTIALS_FILE: emptyAwsConfig,
  AWS_CONFIG_FILE: emptyAwsConfig,
  NODE_EXTRA_CA_CERTS: hookTls.cert,
};
// The MX gets its own variables and nothing else, as on the cloud box.
const mxEnv: Record<string, string> = {
  ...baseEnv,
  PROCESS: "mx",
  MX_INGEST_URL: `${API}/internal/mx`,
  MX_INGEST_SECRET: ingestSecret,
  MX_HOSTNAME: MX_HOST,
  MX_PORT: String(PORTS.mx),
  MX_TLS_CERT_PATH: mxTls.cert,
  MX_TLS_KEY_PATH: mxTls.key,
};

type ProcessName = "api" | "worker" | "mx";
const logs: Record<ProcessName, string> = { api: "", worker: "", mx: "" };
const children = new Map<ProcessName, ChildProcess>();

function start(name: ProcessName): ChildProcess {
  const file = createWriteStream(join(out, `${name}.log`), { flags: "a" });
  const child = spawn(process.execPath, [join(root, "scripts/start.mjs")], {
    cwd: root,
    env: name === "mx" ? mxEnv : { ...appEnv, PROCESS: name },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => {
    logs[name] += chunk.toString();
    file.write(chunk);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  children.set(name, child);
  return child;
}

async function startAndWait(name: ProcessName, ready: RegExp, timeoutMs = 120_000) {
  const before = logs[name].length;
  const child = start(name);
  await waitFor(
    () => {
      if (child.exitCode !== null) {
        throw new Error(`${name} exited during boot:\n${logs[name].slice(before).slice(-3000)}`);
      }
      return ready.test(logs[name].slice(before));
    },
    timeoutMs,
    `${name} to start`,
  );
}

async function stop(name: ProcessName) {
  const child = children.get(name);
  children.delete(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

/** scripts/start.mjs with an ad hoc environment: resolves on `ready` in its output, or on exit. */
function runUntil(env: Record<string, string>, ready: RegExp, timeoutMs = 120_000) {
  const child = spawn(process.execPath, [join(root, "scripts/start.mjs")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const done = new Promise<{ child: ChildProcess; output: () => string; exited: number | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(`no ${ready} and no exit within ${timeoutMs} ms:\n${output.slice(-2000)}`),
        );
      }, timeoutMs);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (ready.test(output)) {
          clearTimeout(timer);
          resolve({ child, output: () => output, exited: null });
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ child, output: () => output, exited: code ?? 1 });
      });
    },
  );
  return done;
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

function docker(args: string[]) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

async function startPostgres() {
  docker(["rm", "-f", PG_CONTAINER]);
  const started = docker([
    "run",
    "-d",
    "--rm",
    "--name",
    PG_CONTAINER,
    "-e",
    "POSTGRES_USER=millionsend",
    "-e",
    "POSTGRES_PASSWORD=e2e",
    "-e",
    "POSTGRES_DB=millionsend",
    "-p",
    `127.0.0.1:${PORTS.pg}:5432`,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "postgres:17-alpine",
  ]);
  if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr}`);
  // -h 127.0.0.1: the init-time server listens on the unix socket only, so
  // this answers once the final server is up.
  await waitFor(
    () =>
      docker([
        "exec",
        PG_CONTAINER,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "millionsend",
        "-d",
        "millionsend",
      ]).status === 0,
    60_000,
    "postgres",
  );
}

// --- results -------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  ms: number;
  evidence: string[];
  error?: string;
}
const results: CaseResult[] = [];

async function check(name: string, body: (note: (line: string) => void) => Promise<void>) {
  const evidence: string[] = [];
  const started = Date.now();
  try {
    await body((line) => evidence.push(line));
    results.push({ name, ok: true, ms: Date.now() - started, evidence });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    results.push({ name, ok: false, ms: Date.now() - started, evidence, error });
    console.log(`FAIL  ${name}\n      ${error.split("\n")[0]}`);
  }
}

// --- SMTP clients ------------------------------------------------------------

interface Envelope {
  from: string;
  to: string[];
}
interface SmtpRefusal extends Error {
  code?: string;
  command?: string;
  response?: string;
  responseCode?: number;
}

const composer = createTransport({ streamTransport: true, buffer: true, newline: "windows" });
async function compose(mail: Record<string, unknown>): Promise<Buffer> {
  return (await composer.sendMail({ date: new Date(), ...mail })).message as Buffer;
}

/** Real SMTP into the MX: STARTTLS against its certificate, or cleartext. */
async function smtp(raw: Buffer, envelope: Envelope, mode: "starttls" | "plain" = "starttls") {
  const transport = createTransport({
    host: "127.0.0.1",
    port: PORTS.mx,
    name: `client.${SENDER}`,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 180_000,
    ...(mode === "starttls"
      ? { requireTLS: true, tls: { ca: [mxTls.pem], servername: MX_HOST } }
      : { ignoreTLS: true }),
  });
  try {
    return (await transport.sendMail({ envelope, raw })) as {
      response: string;
      accepted: string[];
      rejected: string[];
    };
  } finally {
    transport.close();
  }
}

async function refused(raw: Buffer, envelope: Envelope): Promise<SmtpRefusal> {
  try {
    const info = await smtp(raw, envelope);
    throw new Error(`expected a refusal, got ${info.response}`);
  } catch (err) {
    const e = err as SmtpRefusal;
    if (!e.responseCode) throw err;
    return e;
  }
}

/** A hand-driven SMTP session, for what a mail library will not say on the wire. */
async function dialog() {
  let socket: Socket | TLSSocket = connect(PORTS.mx, "127.0.0.1");
  await once(socket, "connect");
  let buffer = "";
  const replies: string[] = [];
  let waiting: ((reply: string) => void) | undefined;
  const complete = /^(?:\d{3}-[^\n]*\n)*\d{3}(?: [^\n]*)?\r?\n/;
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("latin1");
    for (let m = complete.exec(buffer); m; m = complete.exec(buffer)) {
      buffer = buffer.slice(m[0].length);
      const reply = m[0].trimEnd();
      const resolve = waiting;
      waiting = undefined;
      if (resolve) resolve(reply);
      else replies.push(reply);
    }
  };
  socket.on("data", onData);
  const read = (timeoutMs = 60_000) =>
    new Promise<string>((resolve, reject) => {
      const queued = replies.shift();
      if (queued !== undefined) return resolve(queued);
      const timer = setTimeout(() => reject(new Error("no SMTP reply")), timeoutMs);
      waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
    });
  const greeting = await read();
  const write = async (bytes: Buffer | string) => {
    if (!socket.write(bytes)) await once(socket, "drain");
  };
  return {
    greeting,
    read,
    write,
    pending: () => replies.length,
    cmd: async (line: string) => {
      await write(`${line}\r\n`);
      return read();
    },
    starttls: async () => {
      await write("STARTTLS\r\n");
      const reply = await read();
      socket.off("data", onData);
      const secure = tlsConnect({ socket, servername: MX_HOST, ca: [mxTls.pem] });
      await once(secure, "secureConnect");
      secure.on("data", onData);
      socket = secure;
      return {
        reply,
        protocol: secure.getProtocol(),
        cn: secure.getPeerCertificate().subject?.CN,
        authorized: secure.authorized,
      };
    },
    close: () => socket.destroy(),
  };
}

// --- database and API helpers ---------------------------------------------

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

interface StoredRow {
  id: string;
  received_for: string[];
  envelope: { tls: { protocol?: string } | null };
  authentication: Record<string, string>;
  size_bytes: number;
  subject: string;
}
async function rowsFor(teamId: string, messageId: string): Promise<StoredRow[]> {
  return sql`
    select id, received_for, envelope, authentication, size_bytes, subject
    from received_emails where team_id = ${teamId} and message_id = ${messageId}`;
}
async function onlyRow(teamId: string, messageId: string): Promise<StoredRow> {
  const rows = await rowsFor(teamId, messageId);
  assert.equal(rows.length, 1, `exactly one row for ${messageId} (found ${rows.length})`);
  return rows[0] as StoredRow;
}
async function usageToday(teamId: string): Promise<{ accepted: number; received: number }> {
  const [row] = await sql`
    select accepted, received from usage_counters
    where team_id = ${teamId} and day = (now() at time zone 'utc')::date`;
  return row ? { accepted: row.accepted, received: row.received } : { accepted: 0, received: 0 };
}

/** The longest the API took to answer the MX's RCPT question while `during` ran. */
async function rcptLatencyDuring<T>(
  during: () => Promise<T>,
): Promise<{ result: T; maxMs: number }> {
  let maxMs = 0;
  let running = true;
  const probe = (async () => {
    while (running) {
      const started = Date.now();
      await fetch(`${API}/internal/mx/rcpt`, {
        method: "POST",
        headers: { authorization: `Bearer ${ingestSecret}`, "content-type": "application/json" },
        body: JSON.stringify({
          recipient: `probe@${A_RECV}`,
          mailFrom: "",
          clientIp: "192.0.2.1",
          helo: "probe.example",
        }),
      })
        .then((res) => res.arrayBuffer())
        .catch(() => undefined);
      maxMs = Math.max(maxMs, Date.now() - started);
      await sleep(100);
    }
  })();
  try {
    return { result: await during(), maxMs };
  } finally {
    running = false;
    await probe;
  }
}

interface SdkResult<T> {
  data: T | null;
  error: { statusCode?: number; name?: string; message?: string } | null;
}
async function ok<T>(call: Promise<SdkResult<T>>, what: string): Promise<T> {
  const { data, error } = await call;
  if (error || !data) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data;
}

/** SES's words for mailauth's results, as the API reports them (core/receiving/message.ts). */
const RESEND_VERDICT: Record<string, string> = {
  pass: "pass",
  fail: "fail",
  softfail: "gray",
  neutral: "gray",
  none: "gray",
  policy: "gray",
  temperror: "processing_failed",
  permerror: "processing_failed",
};

// --- run -------------------------------------------------------------------

for (const [name, port] of Object.entries(PORTS)) {
  if (await portOpen(port)) throw new Error(`port ${port} (${name}) is already in use`);
}
fakeAws.listen(PORTS.aws, "127.0.0.1");
hookServer.listen(PORTS.hooks, "127.0.0.1");
console.log(`e2e run ${run}; logs and report in ${out}`);

let exitCode = 1;
try {
  await startPostgres();
  await startAndWait("api", /api listening on/);

  // Seeded as a customer would have them after verifying their domains; the
  // receiving switch itself goes through the API below.
  const team = async (name: string, plan: string) =>
    (
      await sql`insert into teams (name, slug, plan) values (${name}, ${`${name}-${run}`}, ${plan}) returning id`
    )[0].id as string;
  const domain = async (teamId: string, name: string) =>
    (
      await sql`insert into domains (team_id, name, region, status, verified_at, last_checked_at)
        values (${teamId}, ${name}, 'us-east-1', 'verified', now(), now()) returning id`
    )[0].id as string;
  const apiKey = async (teamId: string, domainId: string | null = null) => {
    const key = generateApiKey();
    await sql`insert into api_keys (team_id, name, token_prefix, key_hash, last4, domain_id)
      values (${teamId}, 'e2e', ${key.tokenPrefix}, ${key.keyHash}, ${key.last4}, ${domainId})`;
    return key.token;
  };
  const teamA = await team("e2e-team-a", "pro");
  const teamB = await team("e2e-team-b", "pro");
  const teamF = await team("e2e-team-f", "free");
  const domA = await domain(teamA, A_RECV);
  const domASend = await domain(teamA, A_SEND);
  const domB = await domain(teamB, B_RECV);
  const domBClash = await domain(teamB, A_RECV);
  const domF = await domain(teamF, F_RECV);
  const domF2 = await domain(teamF, F_RECV2);
  const sdk = (token: string) => new Resend(token, { baseUrl: API });
  const apiA = sdk(await apiKey(teamA));
  const apiASendScoped = sdk(await apiKey(teamA, domASend));
  const apiARecvScoped = sdk(await apiKey(teamA, domA));
  const apiB = sdk(await apiKey(teamB));
  const apiF = sdk(await apiKey(teamF));

  const secrets: Record<string, string> = {};
  for (const [label, client] of [
    ["a", apiA],
    ["b", apiB],
    ["f", apiF],
  ] as const) {
    const created = await ok<{ signing_secret: string }>(
      client.webhooks.create({
        endpoint: `https://127.0.0.1:${PORTS.hooks}/hook/${label}`,
        events: ["email.received"],
      }),
      `webhooks.create ${label}`,
    );
    secrets[label] = created.signing_secret;
  }

  await startAndWait("worker", /millionsend worker running/);
  await startAndWait("mx", /"event":"listening"/, 60_000);

  const sent = new Map<string, Buffer>();
  const latency: { deliver?: number; read?: number } = {};
  const ids: Record<string, string> = {};

  await check(
    "mx boots with only MX_* variables; EHLO offers STARTTLS and SIZE, no AUTH",
    async (note) => {
      note(`mx env keys: ${Object.keys(mxEnv).sort().join(", ")}`);
      assert.match(logs.mx, /"event":"tls_loaded","subject":"CN=mx\.millionsend-dns\.com"/);
      assert.doesNotMatch(logs.mx, /migrat/i, "the mx container runs no migrations");
      const s = await dialog();
      note(`greeting: ${s.greeting}`);
      const ehlo = await s.cmd(`EHLO client.${SENDER}`);
      note(`EHLO: ${ehlo.replace(/\r?\n/g, " | ")}`);
      assert.match(s.greeting, /^220 mx\.millionsend-dns\.com/);
      assert.match(ehlo, /STARTTLS/);
      assert.match(ehlo, new RegExp(`SIZE ${MAX_RECEIVED_MESSAGE_BYTES}`));
      assert.doesNotMatch(ehlo, /AUTH/);
      const auth = await s.cmd("AUTH PLAIN AGUAdGVzdAB0ZXN0");
      note(`AUTH PLAIN: ${auth}`);
      assert.match(auth, /^5\d\d /);
      await s.cmd("QUIT");
      s.close();
    },
  );

  await check("domains: receiving enabled through the API, one team per name", async (note) => {
    const updated = await ok<{
      capabilities: { receiving: string };
      records: { record: string; type: string; value: string; priority: number; name: string }[];
    }>(
      apiA.domains.update({ id: domA, capabilities: { receiving: "enabled" } }),
      "domains.update A",
    );
    const record = updated.records.find((r) => r.record === "Receiving");
    note(`A capabilities=${JSON.stringify(updated.capabilities)} record=${JSON.stringify(record)}`);
    assert.equal(updated.capabilities.receiving, "enabled");
    assert.deepEqual(
      { type: record?.type, name: record?.name, value: record?.value, priority: record?.priority },
      { type: "MX", name: A_RECV, value: MX_HOST, priority: 10 },
    );
    const clash = await apiB.domains.update({
      id: domBClash,
      capabilities: { receiving: "enabled" },
    });
    note(`B enabling the same name: ${JSON.stringify(clash.error)}`);
    assert.equal(clash.error?.statusCode, 409);
    for (const [client, id] of [
      [apiB, domB],
      [apiF, domF],
      [apiF, domF2],
    ] as const) {
      const r = await ok<{ capabilities: { receiving: string } }>(
        client.domains.update({ id, capabilities: { receiving: "enabled" } }),
        "domains.update",
      );
      assert.equal(r.capabilities.receiving, "enabled");
    }
    const sending = await ok<{ capabilities: { receiving: string } }>(
      apiA.domains.get(domASend),
      "domains.get",
    );
    assert.equal(sending.capabilities.receiving, "disabled");
    note(`${A_SEND} stays receiving=disabled`);
  });

  await check("plain text over cleartext SMTP, stored before the 250", async (note) => {
    const mid = msgId("plain");
    const to = "Support@Inbound.Team-A.Example";
    const text = `Hello from the e2e run.\r\n${CANARY_BODY}\r\n`;
    const raw = await compose({
      from: `Plain Sender <plain@${SENDER}>`,
      to,
      subject: `Plain ${CANARY_SUBJECT}`,
      text,
      messageId: mid,
    });
    sent.set("plain", raw);
    const info = await smtp(raw, { from: BOUNCE, to: [to] }, "plain");
    note(`smtp: ${info.response}`);
    const row = await onlyRow(teamA, mid);
    ids.plain = row.id;
    note(
      `row ${row.id} received_for=${JSON.stringify(row.received_for)} tls=${JSON.stringify(row.envelope.tls)}`,
    );
    assert.equal(row.envelope.tls, null);
    const email = await ok<Record<string, unknown> & { raw: { download_url: string } | null }>(
      apiA.emails.receiving.get(row.id),
      "receiving.get",
    );
    assert.equal(email.object, "email");
    assert.equal(email.from, `plain@${SENDER}`);
    assert.deepEqual(email.to, ["Support@inbound.team-a.example"]);
    assert.deepEqual(email.received_for, ["Support@inbound.team-a.example"]);
    assert.equal(email.subject, `Plain ${CANARY_SUBJECT}`);
    assert.equal(email.message_id, mid);
    assert.equal(String(email.text).replace(/\r\n/g, "\n"), text.replace(/\r\n/g, "\n"));
    assert.equal(email.html, null);
    assert.equal((email.headers as Record<string, string>)["message-id"], mid);
    assert.ok(email.raw?.download_url.startsWith(`${API}/receiving/raw/${row.id}?`));
    note(`api get: subject, text, received_for, headers and raw link as sent`);
  });

  await check(
    "html with an inline cid image: data_uri by default, cid on request",
    async (note) => {
      const mid = msgId("cid");
      const raw = await compose({
        from: `Html Sender <html@${SENDER}>`,
        to: `hello@${A_RECV}`,
        subject: `Inline image ${run}`,
        text: "Fallback text.",
        html: '<p>Hello <b>world</b></p><img src="cid:logo@e2e" alt="logo">',
        attachments: [
          { filename: "logo.png", content: PNG, contentType: "image/png", cid: "logo@e2e" },
        ],
        messageId: mid,
      });
      sent.set("cid", raw);
      note(`smtp: ${(await smtp(raw, { from: BOUNCE, to: [`hello@${A_RECV}`] })).response}`);
      const row = await onlyRow(teamA, mid);
      ids.cid = row.id;
      type Email = { html: string; html_format: string; attachments: Record<string, unknown>[] };
      const inlined = await ok<Email>(apiA.emails.receiving.get(row.id), "get data_uri");
      assert.equal(inlined.html_format, "data_uri");
      assert.ok(inlined.html.includes(`data:image/png;base64,${PNG.toString("base64")}`));
      assert.ok(!inlined.html.includes("cid:logo@e2e"));
      const cid = await ok<Email>(
        apiA.emails.receiving.get(row.id, { html_format: "cid" }),
        "get cid",
      );
      assert.equal(cid.html_format, "cid");
      assert.ok(cid.html.includes('src="cid:logo@e2e"'));
      note(`html_format=data_uri inlines the PNG; html_format=cid keeps src="cid:logo@e2e"`);
      assert.deepEqual(
        inlined.attachments.map(({ id: _id, ...rest }) => rest),
        [
          {
            filename: "logo.png",
            content_type: "image/png",
            content_id: "logo@e2e",
            content_disposition: "inline",
            size: PNG.length,
          },
        ],
      );
      note(`attachments: ${JSON.stringify(inlined.attachments)}`);
    },
  );

  await check("multiple attachments (PDF, PNG): list, get and signed downloads", async (note) => {
    const mid = msgId("multi");
    const files = [
      { filename: "fatura-março.pdf", content: PDF, contentType: "application/pdf" },
      { filename: "grafico.png", content: PNG2, contentType: "image/png" },
    ];
    const raw = await compose({
      from: `Files <files@${SENDER}>`,
      to: `financeiro@${A_RECV}`,
      subject: `Two files ${run}`,
      text: "Two files attached.",
      attachments: files,
      messageId: mid,
    });
    sent.set("multi", raw);
    note(`smtp: ${(await smtp(raw, { from: BOUNCE, to: [`financeiro@${A_RECV}`] })).response}`);
    const row = await onlyRow(teamA, mid);
    ids.multi = row.id;
    type Attachment = {
      id: string;
      filename: string;
      size: number;
      content_type: string;
      content_disposition: string;
      download_url: string;
      expires_at: string;
    };
    const list = await ok<{ object: string; has_more: boolean; data: Attachment[] }>(
      apiA.emails.receiving.attachments.list({ emailId: row.id }),
      "attachments.list",
    );
    assert.equal(list.object, "list");
    assert.equal(list.data.length, 2);
    for (const file of files) {
      const listed = list.data.find((a) => a.filename === file.filename);
      assert.ok(listed, `${file.filename} listed`);
      const one = await ok<Attachment & { object: string }>(
        apiA.emails.receiving.attachments.get({ emailId: row.id, id: listed.id }),
        "attachments.get",
      );
      assert.equal(one.object, "attachment");
      assert.equal(one.size, file.content.length);
      assert.equal(one.content_type, file.contentType);
      assert.equal(one.content_disposition, "attachment");
      const ttl = Date.parse(one.expires_at) - Date.now();
      assert.ok(ttl > 55 * 60_000 && ttl <= 60 * 60_000, `expires in about an hour (${ttl} ms)`);
      const res = await fetch(one.download_url);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(res.status, 200);
      assert.equal(sha256(bytes), sha256(file.content));
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment; /);
      note(
        `${file.filename}: ${bytes.length} bytes, sha256 matches; content-disposition=${res.headers.get("content-disposition")}`,
      );
    }
  });

  await check(
    "raw download is the stored message; forged, expired and cross-team links refused",
    async (note) => {
      const email = await ok<{ raw: { download_url: string } }>(
        apiA.emails.receiving.get(ids.plain as string),
        "get",
      );
      const res = await fetch(email.raw.download_url);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "message/rfc822");
      assert.ok(
        sameMessage(body, sent.get("plain") as Buffer),
        "downloaded bytes are the sent message",
      );
      note(`raw: ${body.length} bytes, same as sent; ${res.headers.get("content-disposition")}`);
      const url = new URL(email.raw.download_url);
      const signature = url.searchParams.get("signature") ?? "";
      const flipped = new URL(url);
      flipped.searchParams.set(
        "signature",
        `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
      );
      const otherEmail = new URL(url);
      otherEmail.pathname = `/receiving/raw/${ids.cid}`;
      const key = deriveReceivedDownloadKey(masterKey);
      const sign = (teamId: string, emailId: string, now: Date) =>
        signReceivedDownload({ key, baseUrl: API, teamId, emailId, now }).url;
      const expired = sign(teamA, ids.plain as string, new Date(Date.now() - 2 * 3_600_000));
      const otherTeam = sign(teamB, ids.plain as string, new Date());
      const control = sign(teamA, ids.plain as string, new Date());
      for (const [label, target, want] of [
        ["one signature character changed", flipped.href, 403],
        ["another email's id under this signature", otherEmail.href, 403],
        ["validly signed but expired", expired, 403],
        ["signed for another team", otherTeam, 403],
        ["no signature", `${API}/receiving/raw/${ids.plain}`, 403],
        [
          "path traversal",
          `${API}/receiving/raw/..%2F..%2Fetc%2Fpasswd?expires=1&signature=x`,
          403,
        ],
        ["control: signed with the same key, valid now", control, 200],
      ] as const) {
        const status = (await fetch(target)).status;
        note(`${label}: ${status}`);
        assert.equal(status, want, label);
      }
    },
  );

  await check("pt-BR subject and body: UTF-8 encoded words and ISO-8859-1", async (note) => {
    const mid = msgId("ptbr");
    const subject = `Relatório de março — ação necessária ½ ${run}`;
    const text =
      "Olá! Segue o relatório de março.\nAtenção às ações pendentes: café, pão e maçã.\nObrigado,\nJoão";
    const raw = await compose({
      from: '"João Conceição" <joao.remetente@gmail.com>',
      to: `vendas@${A_RECV}`,
      subject,
      text,
      html: "<p>Olá! Segue o <b>relatório</b> de março — ações: café, pão e maçã.</p>",
      messageId: mid,
    });
    const subjectLine = raw.toString("latin1").match(/^Subject: .*$/m)?.[0] ?? "";
    note(`on the wire: ${subjectLine}`);
    assert.match(subjectLine, /=\?UTF-8\?/);
    note(
      `smtp: ${(await smtp(raw, { from: "joao.remetente@gmail.com", to: [`vendas@${A_RECV}`] })).response}`,
    );
    const row = await onlyRow(teamA, mid);
    ids.ptbr = row.id;
    const email = await ok<{
      subject: string;
      text: string;
      html: string;
      from: string;
      authentication: Record<string, string>;
    }>(apiA.emails.receiving.get(row.id), "get");
    assert.equal(row.subject, subject);
    assert.equal(email.subject, subject);
    assert.equal(email.text.trim().replace(/\r\n/g, "\n"), text);
    assert.ok(email.html.includes("relatório"));
    assert.equal(email.from, "joao.remetente@gmail.com");
    note(
      `subject and text round-trip; authentication mailauth=${JSON.stringify(row.authentication)} api=${JSON.stringify(email.authentication)}`,
    );
    for (const check of ["spf", "dkim", "dmarc"]) {
      assert.equal(
        email.authentication[check],
        RESEND_VERDICT[row.authentication[check] ?? ""] ?? "unknown",
      );
    }

    const latinMid = msgId("latin1");
    const latin = Buffer.concat([
      Buffer.from(
        [
          `From: =?ISO-8859-1?Q?Jos=E9_Ara=FAjo?= <jose@loja.example>`,
          `To: promo@${A_RECV}`,
          `Subject: =?ISO-8859-1?Q?Promo=E7=E3o_de_ver=E3o?= ${run}`,
          `Message-ID: ${latinMid}`,
          `Date: ${new Date().toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=ISO-8859-1",
          "Content-Transfer-Encoding: 8bit",
          "",
          "",
        ].join("\r\n"),
      ),
      Buffer.from("Promoção válida até sábado.\r\n", "latin1"),
    ]);
    note(
      `smtp latin1: ${(await smtp(latin, { from: "jose@loja.example", to: [`promo@${A_RECV}`] })).response}`,
    );
    const latinRow = await onlyRow(teamA, latinMid);
    const latinEmail = await ok<{ subject: string; text: string }>(
      apiA.emails.receiving.get(latinRow.id),
      "get latin1",
    );
    assert.equal(latinEmail.subject, `Promoção de verão ${run}`);
    assert.equal(latinEmail.text.trim(), "Promoção válida até sábado.");
    note(
      `ISO-8859-1: subject=${JSON.stringify(latinEmail.subject)} text=${JSON.stringify(latinEmail.text.trim())}`,
    );
  });

  await check("~30 MB message accepted, readable and downloadable", async (note) => {
    const mid = msgId("big");
    const blob = randomBytes(22 * 1024 * 1024);
    const raw = await compose({
      from: `Big <big@${SENDER}>`,
      to: `dados@${A_RECV}`,
      subject: `Thirty megabytes ${run}`,
      text: "A large attachment.",
      attachments: [{ filename: "dados.bin", content: blob }],
      messageId: mid,
    });
    assert.ok(raw.length > 29e6 && raw.length < 32e6, `raw size ${raw.length}`);
    const started = Date.now();
    const stored = await rcptLatencyDuring(() =>
      smtp(raw, { from: BOUNCE, to: [`dados@${A_RECV}`] }),
    );
    note(`smtp (${raw.length} bytes): ${stored.result.response} in ${Date.now() - started} ms`);
    latency.deliver = stored.maxMs;
    const row = await onlyRow(teamA, mid);
    assert.ok(Math.abs(row.size_bytes - raw.length) <= 2, `size_bytes ${row.size_bytes}`);
    const t = Date.now();
    const read = await rcptLatencyDuring(() =>
      ok<{ attachments: { id: string; size: number }[] }>(apiA.emails.receiving.get(row.id), "get"),
    );
    latency.read = read.maxMs;
    const email = read.result;
    note(`api get in ${Date.now() - t} ms; attachment size ${email.attachments[0]?.size}`);
    assert.equal(email.attachments[0]?.size, blob.length);
    const attachment = await ok<{ download_url: string }>(
      apiA.emails.receiving.attachments.get({
        emailId: row.id,
        id: email.attachments[0]?.id as string,
      }),
      "attachments.get",
    );
    const bytes = Buffer.from(await (await fetch(attachment.download_url)).arrayBuffer());
    assert.equal(sha256(bytes), sha256(blob));
    note(`attachment download: ${bytes.length} bytes, sha256 matches`);
  });

  await check(
    "the API keeps answering the MX's RCPT questions while it stores and reads ~30 MB",
    async (note) => {
      note(
        `longest /internal/mx/rcpt answer while storing: ${latency.deliver} ms; while reading it back: ${latency.read} ms (the MX gives up after 15000 ms)`,
      );
      assert.ok(latency.deliver !== undefined && latency.read !== undefined, "measured above");
      assert.ok(latency.deliver < 1000 && latency.read < 1000, "RCPT answers stay under a second");
    },
  );

  await check(
    ">40 MB message refused with 552 during DATA (and at MAIL FROM when SIZE is declared)",
    async (note) => {
      const mid = msgId("huge");
      const raw = await compose({
        from: `Huge <huge@${SENDER}>`,
        to: `dados@${A_RECV}`,
        subject: `Too big ${run}`,
        text: "Over the limit.",
        attachments: [{ filename: "huge.bin", content: randomBytes(31 * 1024 * 1024) }],
        messageId: mid,
      });
      assert.ok(raw.length > MAX_RECEIVED_MESSAGE_BYTES);
      const err = await refused(raw, { from: BOUNCE, to: [`dados@${A_RECV}`] });
      note(
        `nodemailer (${raw.length} bytes, no SIZE= parameter): command=${err.command} response=${err.response}`,
      );
      assert.equal(err.command, "DATA");
      assert.equal(err.responseCode, 552);
      assert.match(err.response ?? "", /^552 5\.3\.4 /);
      assert.equal((await rowsFor(teamA, mid)).length, 0, "nothing stored");
      const s = await dialog();
      await s.cmd(`EHLO client.${SENDER}`);
      const mail = await s.cmd(`MAIL FROM:<${BOUNCE}> SIZE=${MAX_RECEIVED_MESSAGE_BYTES + 1}`);
      note(`MAIL FROM ... SIZE=${MAX_RECEIVED_MESSAGE_BYTES + 1}: ${mail}`);
      assert.match(mail, /^552 /);
      await s.cmd("QUIT");
      s.close();
    },
  );

  await check(
    "unknown domain refused with 550 at RCPT; so is a verified domain without receiving",
    async (note) => {
      const raw = await compose({ from: BOUNCE, to: "x@y.example", subject: "relay?", text: "no" });
      for (const to of ["someone@unknown-domain.example", `ceo@${A_SEND}`]) {
        const err = await refused(raw, { from: BOUNCE, to: [to] });
        note(`${to}: command=${err.command} response=${err.response}`);
        assert.equal(err.command, "RCPT TO");
        assert.match(err.response ?? "", /^550 5\.1\.1 /);
      }
    },
  );

  await check(
    "STARTTLS negotiated: TLS 1.3 with the MX certificate, recorded on the row",
    async (note) => {
      const s = await dialog();
      await s.cmd(`EHLO client.${SENDER}`);
      const upgraded = await s.starttls();
      note(
        `STARTTLS: ${upgraded.reply}; ${upgraded.protocol}; peer CN=${upgraded.cn}; verified=${upgraded.authorized}`,
      );
      assert.match(upgraded.reply, /^220 /);
      assert.equal(upgraded.protocol, "TLSv1.3");
      assert.equal(upgraded.cn, MX_HOST);
      assert.equal(upgraded.authorized, true);
      const ehlo = await s.cmd(`EHLO client.${SENDER}`);
      assert.doesNotMatch(ehlo, /STARTTLS/, "not offered twice");
      await s.cmd("QUIT");
      s.close();
      const mid = msgId("tls");
      const raw = await compose({
        from: `Tls <tls@${SENDER}>`,
        to: `seguro@${A_RECV}`,
        subject: `Over TLS ${run}`,
        text: "Sent over STARTTLS.",
        messageId: mid,
      });
      note(
        `smtp (requireTLS): ${(await smtp(raw, { from: BOUNCE, to: [`seguro@${A_RECV}`] })).response}`,
      );
      const row = await onlyRow(teamA, mid);
      note(`row envelope.tls=${JSON.stringify(row.envelope.tls)}`);
      assert.equal(row.envelope.tls?.protocol, "TLSv1.3");
    },
  );

  await check(
    "ingest unavailable: 451 at RCPT and at DATA; delivered once the API is back",
    async (note) => {
      const warm = await compose({
        from: `Warm <warm@${SENDER}>`,
        to: `ops@${A_RECV}`,
        subject: `Warm cache ${run}`,
        text: "warm",
        messageId: msgId("warm"),
      });
      await smtp(warm, { from: BOUNCE, to: [`ops@${A_RECV}`] });
      const mid = msgId("outage");
      const raw = await compose({
        from: `Outage <outage@${SENDER}>`,
        to: `ops@${A_RECV}`,
        subject: `During the outage ${run}`,
        text: "Sent while the API was down.",
        messageId: mid,
      });
      await stop("api");
      try {
        await waitFor(async () => !(await portOpen(PORTS.api)), 30_000, "api to stop");
        note("api stopped");
        const atData = await refused(raw, { from: BOUNCE, to: [`ops@${A_RECV}`] });
        note(
          `domain answer cached by the MX: command=${atData.command} response=${atData.response}`,
        );
        assert.equal(atData.command, "DATA");
        assert.match(atData.response ?? "", /^451 4\.3\.0 /);
        const atRcpt = await refused(raw, { from: BOUNCE, to: ["someone@never-asked.example"] });
        note(`domain not cached: command=${atRcpt.command} response=${atRcpt.response}`);
        assert.equal(atRcpt.command, "RCPT TO");
        assert.match(atRcpt.response ?? "", /^451 4\.3\.0 /);
        await waitFor(
          () => /"event":"deliver_failed"/.test(logs.mx) && /"event":"rcpt_failed"/.test(logs.mx),
          10_000,
          "the MX to log deliver_failed and rcpt_failed",
        );
      } finally {
        // Every later case needs the API, whatever happened above.
        await startAndWait("api", /api listening on/);
        note("api restarted");
      }
      const info = await smtp(raw, { from: BOUNCE, to: [`ops@${A_RECV}`] });
      note(`retry: ${info.response}`);
      await onlyRow(teamA, mid);
    },
  );

  await check(
    "duplicate delivery of the same raw message stores one row and fires one webhook",
    async (note) => {
      const mid = msgId("dup");
      const raw = await compose({
        from: `Dup <dup@${SENDER}>`,
        to: `dup@${A_RECV}`,
        subject: `Twice ${run}`,
        text: "Delivered twice.",
        messageId: mid,
      });
      const before = await usageToday(teamA);
      const first = await smtp(raw, { from: BOUNCE, to: [`dup@${A_RECV}`] });
      const second = await smtp(raw, { from: BOUNCE, to: [`dup@${A_RECV}`] });
      note(`first: ${first.response}; second: ${second.response}`);
      const row = await onlyRow(teamA, mid);
      const after = await usageToday(teamA);
      note(`usage received ${before.received} -> ${after.received}`);
      assert.equal(after.received - before.received, 1);
      await waitFor(() => hooksFor(row.id).length > 0, 30_000, "webhook");
      await sleep(3000);
      note(`webhooks for ${row.id}: ${hooksFor(row.id).length}`);
      assert.equal(hooksFor(row.id).length, 1);

      const racedMid = msgId("dup-race");
      const raced = await compose({
        from: `Dup <dup@${SENDER}>`,
        to: `dup@${A_RECV}`,
        subject: `Twice at once ${run}`,
        text: "Delivered twice in parallel.",
        messageId: racedMid,
      });
      const both = await Promise.all([
        smtp(raced, { from: BOUNCE, to: [`dup@${A_RECV}`] }),
        smtp(raced, { from: BOUNCE, to: [`dup@${A_RECV}`] }),
      ]);
      note(`in parallel: ${both.map((i) => i.response).join("; ")}`);
      const racedRow = await onlyRow(teamA, racedMid);
      await waitFor(() => hooksFor(racedRow.id).length > 0, 30_000, "webhook");
      await sleep(3000);
      note(`parallel pair: one row ${racedRow.id}, webhooks ${hooksFor(racedRow.id).length}`);
      assert.equal(hooksFor(racedRow.id).length, 1);
    },
  );

  await check(
    "two recipients in two teams: two rows, no recipient leak; domain-scoped keys",
    async (note) => {
      const mid = msgId("split");
      const a = `alice@${A_RECV}`;
      const b = `bob@${B_RECV}`;
      const raw = await compose({
        from: `Split <split@${SENDER}>`,
        to: a,
        subject: `Two teams ${run}`,
        text: "One message, two teams.",
        messageId: mid,
      });
      note(`smtp (RCPT ${a}, ${b}): ${(await smtp(raw, { from: BOUNCE, to: [a, b] })).response}`);
      const rowA = await onlyRow(teamA, mid);
      const rowB = await onlyRow(teamB, mid);
      note(`team A row ${rowA.id} received_for=${JSON.stringify(rowA.received_for)}`);
      note(`team B row ${rowB.id} received_for=${JSON.stringify(rowB.received_for)}`);
      assert.deepEqual(rowA.received_for, [a]);
      assert.deepEqual(rowB.received_for, [b]);
      const crossA = await apiA.emails.receiving.get(rowB.id);
      const crossB = await apiB.emails.receiving.get(rowA.id);
      note(
        `A reads B's id: ${crossA.error?.statusCode}; B reads A's id: ${crossB.error?.statusCode}`,
      );
      assert.equal(crossA.error?.statusCode, 404);
      assert.equal(crossB.error?.statusCode, 404);
      const listB = await ok<{ data: { id: string; received_for: string[] }[] }>(
        apiB.emails.receiving.list({ limit: 100 }),
        "list B",
      );
      assert.deepEqual(
        listB.data.map((e) => e.id),
        [rowB.id],
      );
      assert.deepEqual(listB.data[0]?.received_for, [b]);
      const [hookA, hookB] = await Promise.all([
        waitFor(() => hooksFor(rowA.id)[0], 30_000, "webhook A"),
        waitFor(() => hooksFor(rowB.id)[0], 30_000, "webhook B"),
      ]);
      assert.equal(hookA.team, "a");
      assert.equal(hookB.team, "b");
      // B's address is in the envelope only (A's is also the To header), so
      // it must not appear anywhere team A can see.
      assert.ok(!hookA.body.includes(b), "team A's webhook never names B's recipient");
      assert.ok(!JSON.stringify(await apiA.emails.receiving.get(rowA.id)).includes(b));
      assert.deepEqual(hookData(hookA).received_for, [a]);
      assert.deepEqual(hookData(hookB).received_for, [b]);
      note(
        `webhook A received_for=${JSON.stringify(hookData(hookA).received_for)}, webhook B received_for=${JSON.stringify(hookData(hookB).received_for)}`,
      );
      const scopedSend = await ok<{ data: { id: string }[] }>(
        apiASendScoped.emails.receiving.list({ limit: 100 }),
        "list scoped to the sending domain",
      );
      const scopedRecv = await ok<{ data: { id: string }[] }>(
        apiARecvScoped.emails.receiving.list({ limit: 100 }),
        "list scoped to the receiving domain",
      );
      note(
        `key scoped to ${A_SEND}: ${scopedSend.data.length} emails; key scoped to ${A_RECV}: ${scopedRecv.data.length} emails`,
      );
      assert.equal(scopedSend.data.length, 0);
      assert.ok(scopedRecv.data.some((e) => e.id === rowA.id));
      const scopedGet = await apiASendScoped.emails.receiving.get(rowA.id);
      assert.equal(scopedGet.error?.statusCode, 404);
    },
  );

  await check(
    "Free plan over the shared daily cap: 452 at RCPT (and at DATA from a cached answer)",
    async (note) => {
      const quota = teamQuota(
        {
          plan: "free",
          planQuota: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          overageEnabled: false,
        },
        true,
      );
      assert.equal(quota.kind, "day");
      const ceiling = Math.floor((quota.kind === "day" ? quota.limit : 0) * (1 + QUOTA_TOLERANCE));
      const first = await compose({
        from: `Free <free@${SENDER}>`,
        to: `oi@${F_RECV}`,
        subject: `Free plan ${run}`,
        text: "Within the cap.",
        messageId: msgId("free1"),
      });
      const before = await usageToday(teamF);
      note(
        `within the cap: ${(await smtp(first, { from: BOUNCE, to: [`oi@${F_RECV}`] })).response}`,
      );
      const after = await usageToday(teamF);
      note(
        `usage accepted ${before.accepted}->${after.accepted}, received ${before.received}->${after.received} (shared counter)`,
      );
      assert.equal(after.accepted - before.accepted, 1);
      assert.equal(after.received - before.received, 1);
      await sql`update usage_counters set accepted = ${ceiling}
      where team_id = ${teamF} and day = (now() at time zone 'utc')::date`;
      note(`set today's shared counter to the ceiling (${ceiling} = Free limit plus tolerance)`);
      const second = await compose({
        from: `Free <free@${SENDER}>`,
        to: `oi@${F_RECV}`,
        subject: `Free plan over ${run}`,
        text: "Over the cap.",
        messageId: msgId("free2"),
      });
      const cached = await refused(second, { from: BOUNCE, to: [`oi@${F_RECV}`] });
      note(
        `same domain, answer cached by the MX: command=${cached.command} response=${cached.response}`,
      );
      assert.match(cached.response ?? "", /^452 4\.2\.2 /);
      const fresh = await refused(second, { from: BOUNCE, to: [`oi@${F_RECV2}`] });
      note(`domain not cached: command=${fresh.command} response=${fresh.response}`);
      assert.equal(fresh.command, "RCPT TO");
      assert.match(fresh.response ?? "", /^452 4\.2\.2 /);
      const end = await usageToday(teamF);
      assert.deepEqual(
        end,
        { accepted: ceiling, received: after.received },
        "refusals count nothing",
      );
      assert.equal((await rowsFor(teamF, msgId("free2"))).length, 0);
    },
  );

  await check(
    "forward() passthrough through the SDK: subject, html and the inline cid image survive",
    async (note) => {
      const original = await ok<{ subject: string }>(
        apiA.emails.receiving.get(ids.cid as string),
        "get",
      );
      const passthrough = await ok<{ id: string }>(
        apiA.emails.receiving.forward({
          emailId: ids.cid,
          to: "ops@destino.example",
          from: `Encaminhamento <fwd@${A_SEND}>`,
        }),
        "forward passthrough",
      );
      note(`passthrough: POST /emails accepted ${passthrough.id}`);
      const sentPass = await waitFor(
        () => sesSends.find((s) => s.tags.millionsend_email_id === passthrough.id),
        90_000,
        "the forwarded email at SES",
      );
      const parsed = await simpleParser(sentPass.raw, { keepCidLinks: true });
      const image = parsed.attachments.find((a: { cid?: string }) => a.cid === "logo@e2e");
      note(
        `at SES: subject=${JSON.stringify(parsed.subject)} inline cid=${image?.cid} ${image?.contentDisposition} ${image?.size} bytes; html keeps cid: ${String(parsed.html).includes("cid:logo@e2e")}`,
      );
      assert.equal(parsed.subject, original.subject);
      assert.ok(image, "inline image forwarded with its Content-ID");
      assert.ok(Buffer.from(image.content).equals(PNG));
      assert.ok(String(parsed.html).includes("cid:logo@e2e"));
    },
  );

  // The wrapped forward's MIME, read part by part: mailparser folds an inline
  // message/rfc822 part into the body, which would hide how it was sent.
  let wrappedPart: { headers: string; body: string } | undefined;
  await check(
    "forward() wrapped: the original arrives intact as forwarded_message.eml",
    async (note) => {
      const wrapped = await ok<{ id: string }>(
        apiA.emails.receiving.forward({
          emailId: ids.multi,
          to: "ops@destino.example",
          from: `Encaminhamento <fwd@${A_SEND}>`,
          passthrough: false,
          text: "Segue o e-mail original.",
        }),
        "forward wrapped",
      );
      note(`wrapped: POST /emails accepted ${wrapped.id}`);
      const captured = await waitFor(
        () => sesSends.find((s) => s.tags.millionsend_email_id === wrapped.id),
        90_000,
        "the wrapped forward at SES",
      );
      const text = captured.raw.toString("latin1");
      const boundary = /^Content-Type: multipart\/mixed;\s*boundary="?([^"\r\n]+)"?/im.exec(
        text,
      )?.[1];
      assert.ok(boundary, "a multipart/mixed message");
      wrappedPart = text
        .split(`--${boundary}`)
        .map((part) => {
          const at = part.indexOf("\r\n\r\n");
          return { headers: part.slice(0, at), body: part.slice(at + 4) };
        })
        .find((part) => /Content-Type: message\/rfc822/i.test(part.headers));
      assert.ok(wrappedPart, "a message/rfc822 part");
      note(`part headers: ${wrappedPart.headers.trim().replace(/\r\n/g, " | ")}`);
      assert.match(wrappedPart.headers, /name="?forwarded_message\.eml/);
      const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
      assert.equal(
        normalize(wrappedPart.body),
        normalize((sent.get("multi") as Buffer).toString("latin1")),
        "the part is the original message, byte for byte",
      );
      note("the part's body is the received message as stored");
    },
  );

  await check(
    "forward() wrapped: forwarded_message.eml is sent as an attachment, not inline",
    async (note) => {
      assert.ok(wrappedPart, "needs the wrapped forward above");
      const disposition = /^Content-Disposition: ([^;\r\n]+)/im.exec(wrappedPart.headers)?.[1];
      note(`Content-Disposition of the message/rfc822 part: ${disposition}`);
      assert.equal(
        disposition,
        "attachment",
        "POST /emails attachments without content_id are attachments; this one goes out inline",
      );
    },
  );

  await check(
    "recipients past 50 hear 452 4.5.3, and the sender's retry of the rest reaches webhook consumers",
    async (note) => {
      const mid = msgId("many");
      const recipients = Array.from({ length: 51 }, (_, i) => `agent${i + 1}@${A_RECV}`);
      const raw = await compose({
        from: `Many <many@${SENDER}>`,
        to: `team@${A_RECV}`,
        subject: `Fifty-one recipients ${run}`,
        text: "One message, fifty-one envelope recipients.",
        messageId: mid,
      });
      const first = await smtp(raw, { from: BOUNCE, to: recipients });
      const rejected = (first as { rejectedErrors?: { response?: string }[] }).rejectedErrors ?? [];
      note(
        `first transaction: ${first.accepted.length} accepted, rejected ${JSON.stringify(first.rejected)} with ${rejected[0]?.response}`,
      );
      assert.equal(first.accepted.length, 50);
      assert.deepEqual(first.rejected, [recipients[50]]);
      assert.match(rejected[0]?.response ?? "", /^452 4\.5\.3 /);
      // What the sender's queue does next: the same bytes, to the one left.
      const retry = await smtp(raw, { from: BOUNCE, to: [recipients[50] as string] });
      note(`retry for the 51st: ${retry.response}`);
      const row = await onlyRow(teamA, mid);
      note(`one row ${row.id}, received_for has ${row.received_for.length} addresses`);
      assert.equal(row.received_for.length, 51);
      await waitFor(() => hooksFor(row.id).length > 0, 30_000, "webhook");
      await sleep(3000);
      const told = new Set(hooksFor(row.id).flatMap((h) => hookData(h).received_for as string[]));
      note(
        `email.received deliveries: ${hooksFor(row.id).length}; recipients named in them: ${told.size} of 51`,
      );
      assert.ok(
        recipients.every((r) => told.has(r)),
        `webhook consumers never hear about ${recipients.filter((r) => !told.has(r)).join(", ")}`,
      );
    },
  );

  await check("a bounce from the null sender <> is accepted and stored", async (note) => {
    const mid = msgId("dsn");
    const s = await dialog();
    await s.cmd(`EHLO mail.${SENDER}`);
    const mail = await s.cmd("MAIL FROM:<>");
    const rcpt = await s.cmd(`RCPT TO:<bounces@${A_RECV}>`);
    const data = await s.cmd("DATA");
    note(`MAIL FROM:<> ${mail}; RCPT ${rcpt}; DATA ${data}`);
    await s.write(
      [
        `From: Mail Delivery System <MAILER-DAEMON@mail.${SENDER}>`,
        `To: bounces@${A_RECV}`,
        `Subject: Undelivered Mail Returned to Sender ${run}`,
        `Message-ID: ${mid}`,
        "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "Your message could not be delivered.",
        "--b1",
        "Content-Type: message/delivery-status",
        "",
        "Reporting-MTA: dns; mail.sender.e2e.example",
        "",
        "Final-Recipient: rfc822; nobody@elsewhere.example",
        "Action: failed",
        "Status: 5.1.1",
        "--b1--",
        ".",
        "",
      ].join("\r\n"),
    );
    const end = await s.read();
    note(`end of DATA: ${end}`);
    await s.cmd("QUIT");
    s.close();
    assert.match(mail, /^250/);
    assert.match(end, /^250 /);
    const row = await onlyRow(teamA, mid);
    const [stored] = await sql`select "from", envelope from received_emails where id = ${row.id}`;
    note(`row from=${stored.from} envelope.mailFrom=${JSON.stringify(stored.envelope.mailFrom)}`);
    assert.equal(stored.envelope.mailFrom, "");
    assert.equal(stored.from, `MAILER-DAEMON@mail.${SENDER}`);
  });

  await check(
    "malformed MIME is stored with minimal metadata and stays downloadable",
    async (note) => {
      const raw = Buffer.concat([
        Buffer.from("this is not a header block\r\n\r\n--no-boundary\r\nContent-Type: \r\n"),
        Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a]),
        Buffer.from(`=?broken?Q?${run}\r\n`),
      ]);
      note(`smtp: ${(await smtp(raw, { from: `odd@${SENDER}`, to: [`odd@${A_RECV}`] })).response}`);
      const [row] = await sql`
      select id, "from", subject, message_id from received_emails
      where team_id = ${teamA} and raw_sha256 in (${sha256(raw)}, ${sha256(Buffer.concat([raw, Buffer.from("\r\n")]))})`;
      assert.ok(row, "stored");
      note(
        `row ${row.id}: from=${JSON.stringify(row.from)} subject=${JSON.stringify(row.subject)} message_id=${row.message_id}`,
      );
      assert.equal(row.from, `odd@${SENDER}`);
      const email = await ok<{ raw: { download_url: string }; html: unknown }>(
        apiA.emails.receiving.get(row.id),
        "get",
      );
      const body = Buffer.from(await (await fetch(email.raw.download_url)).arrayBuffer());
      assert.ok(sameMessage(body, raw), "raw download returns the bytes as received");
      note(`api get answers; raw download returns the ${body.length} bytes received`);
    },
  );

  await check(
    "CR/LF hidden in encoded words never reaches stored metadata, the API or the webhook",
    async (note) => {
      const mid = msgId("inject");
      const b64 = (value: string) => Buffer.from(value).toString("base64");
      const raw = Buffer.from(
        [
          `From: =?UTF-8?B?${b64("Evil\r\nReply-To: attacker@evil.example")}?= <evil@${SENDER}>`,
          `To: inject@${A_RECV}`,
          `Subject: =?UTF-8?B?${b64(`Olá ${run}\r\nBcc: victim@evil.example\r\nX-Injected: 1`)}?=`,
          `Message-ID: ${mid}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "body",
          "",
        ].join("\r\n"),
      );
      note(`smtp: ${(await smtp(raw, { from: BOUNCE, to: [`inject@${A_RECV}`] })).response}`);
      const row = await onlyRow(teamA, mid);
      const email = await ok<{ subject: string; from: string; headers: Record<string, string> }>(
        apiA.emails.receiving.get(row.id),
        "get",
      );
      const hook = await waitFor(() => hooksFor(row.id)[0], 30_000, "webhook");
      note(`stored subject=${JSON.stringify(row.subject)}; api from=${JSON.stringify(email.from)}`);
      for (const [where, value] of [
        ["stored subject", row.subject],
        ["api subject", email.subject],
        ["webhook subject", String(hookData(hook).subject)],
        ["api headers", Object.values(email.headers).join("")],
      ] as const) {
        assert.doesNotMatch(value, /[\r\n]/, `${where} carries no CR or LF`);
      }
      assert.equal(email.from, `evil@${SENDER}`);
      assert.ok(email.subject.includes("Olá"));
    },
  );

  await check("an SMTPUTF8 recipient (joão@) is accepted and reported as written", async (note) => {
    const mid = msgId("utf8rcpt");
    const to = `joão@${A_RECV}`;
    const raw = await compose({
      from: `Acentos <acentos@${SENDER}>`,
      to,
      subject: `Para o João ${run}`,
      text: "Endereço com acento.",
      messageId: mid,
    });
    note(`smtp: ${(await smtp(raw, { from: BOUNCE, to: [to] })).response}`);
    const row = await onlyRow(teamA, mid);
    const hook = await waitFor(() => hooksFor(row.id)[0], 30_000, "webhook");
    note(
      `received_for=${JSON.stringify(row.received_for)} webhook received_for=${JSON.stringify(hookData(hook).received_for)}`,
    );
    assert.deepEqual(row.received_for, [to]);
    assert.deepEqual(hookData(hook).received_for, [to]);
  });

  await check(
    "sending-only keys get 403; the list pages through every email once",
    async (note) => {
      const key = generateApiKey();
      await sql`insert into api_keys (team_id, name, token_prefix, key_hash, last4, permission)
      values (${teamA}, 'e2e sending', ${key.tokenPrefix}, ${key.keyHash}, ${key.last4}, 'sending_access')`;
      const sending = sdk(key.token);
      const denied = await sending.emails.receiving.list();
      const deniedGet = await sending.emails.receiving.get(ids.plain as string);
      note(
        `sending_access: list ${denied.error?.statusCode} ${denied.error?.name}; get ${deniedGet.error?.statusCode}`,
      );
      assert.equal(denied.error?.statusCode, 403);
      assert.equal(deniedGet.error?.statusCode, 403);
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await ok<{ has_more: boolean; data: { id: string }[] }>(
          apiA.emails.receiving.list({ limit: 4, ...(after ? { after } : {}) }),
          "list page",
        );
        seen.push(...res.data.map((e) => e.id));
        if (!res.has_more) break;
        after = res.data.at(-1)?.id;
      }
      const [{ count }] =
        await sql`select count(*)::int as count from received_emails where team_id = ${teamA}`;
      note(
        `paged ${seen.length} ids (${new Set(seen).size} distinct) in pages of 4; team A has ${count} rows`,
      );
      assert.equal(new Set(seen).size, seen.length);
      assert.equal(seen.length, count);
    },
  );

  await check(
    "email.received webhook: Resend's exact payload, signed, each recipient announced once",
    async (note) => {
      const hook = await waitFor(() => hooksFor(ids.multi as string)[0], 30_000, "webhook");
      const verified = apiA.webhooks.verify({
        payload: hook.body,
        headers: {
          id: String(hook.headers["webhook-id"]),
          timestamp: String(hook.headers["webhook-timestamp"]),
          signature: String(hook.headers["webhook-signature"]),
        },
        webhookSecret: secrets.a,
      });
      note(
        `verified with resend.webhooks.verify; svix-id=${hook.headers["svix-id"] ? "present" : "missing"}`,
      );
      assert.ok(hook.headers["svix-signature"], "svix-* headers sent too");
      assert.deepEqual(Object.keys(verified).sort(), ["created_at", "data", "type"]);
      assert.equal(verified.type, "email.received");
      const data = verified.data;
      assert.deepEqual(Object.keys(data).sort(), [
        "attachments",
        "bcc",
        "cc",
        "created_at",
        "email_id",
        "from",
        "message_id",
        "received_for",
        "subject",
        "to",
      ]);
      for (const attachment of data.attachments) {
        assert.deepEqual(Object.keys(attachment).sort(), [
          "content_disposition",
          "content_id",
          "content_type",
          "filename",
          "id",
        ]);
      }
      const email = await ok<Record<string, unknown> & { attachments: Record<string, unknown>[] }>(
        apiA.emails.receiving.get(ids.multi as string),
        "get",
      );
      for (const field of [
        "from",
        "to",
        "cc",
        "bcc",
        "subject",
        "message_id",
        "received_for",
        "created_at",
      ]) {
        assert.deepEqual(data[field], email[field], `data.${field} matches the API`);
      }
      assert.deepEqual(
        data.attachments,
        email.attachments.map(({ size: _size, ...rest }) => ({
          id: rest.id,
          filename: rest.filename,
          content_type: rest.content_type,
          content_disposition: rest.content_disposition,
          content_id: rest.content_id,
        })),
      );
      note(`payload: ${hook.body.slice(0, 400)}${hook.body.length > 400 ? "…" : ""}`);
      const stored: { id: string; received_for: string[] }[] =
        await sql`select id, received_for from received_emails where team_id = ${teamA}`;
      await waitFor(
        () => stored.every((r) => hooksFor(r.id).length >= 1),
        30_000,
        "a webhook per row",
      );
      await sleep(2000);
      const counts = stored.map((r) => hooksFor(r.id).length);
      note(`team A: ${stored.length} rows, webhook deliveries per row: ${JSON.stringify(counts)}`);
      // One delivery per row, plus one for each later delivery that added
      // recipients to it: across a row's deliveries every recipient is named once.
      for (const row of stored) {
        const told = hooksFor(row.id).flatMap((h) => hookData(h).received_for as string[]);
        assert.deepEqual(
          [...told].sort(),
          [...row.received_for].sort(),
          `row ${row.id}: each recipient in exactly one email.received`,
        );
      }
    },
  );

  await check("SMTP smuggling: <LF>.<LF> and its variants do not end DATA", async (note) => {
    const mid = msgId("smuggle");
    const s = await dialog();
    await s.cmd(`EHLO client.${SENDER}`);
    assert.match(await s.cmd(`MAIL FROM:<${BOUNCE}>`), /^250/);
    assert.match(await s.cmd(`RCPT TO:<target@${A_RECV}>`), /^250/);
    assert.match(await s.cmd("DATA"), /^354/);
    const smuggled = (sep: string, n: number) =>
      `${sep}MAIL FROM:<evil${n}@${SENDER}>\r\nRCPT TO:<victim${n}@${A_RECV}>\r\nDATA\r\nSubject: smuggled ${run}\r\n\r\nevil\r\n`;
    await s.write(
      [
        `From: smuggler@${SENDER}`,
        `To: target@${A_RECV}`,
        `Subject: Smuggling probe ${run}`,
        `Message-ID: ${mid}`,
        "",
        "before",
      ].join("\r\n") +
        smuggled("\n.\n", 1) +
        smuggled("\r\n.\n", 2) +
        smuggled("\n.\r\n", 3) +
        smuggled("\r.\r", 4) +
        "after\r\n.\r\n",
    );
    const end = await s.read();
    await sleep(1500);
    note(`end of DATA: ${end}; further replies: ${s.pending()}`);
    assert.match(end, /^250 /);
    assert.equal(s.pending(), 0, "nothing after the message was read as a command");
    await s.cmd("QUIT");
    s.close();
    const row = await onlyRow(teamA, mid);
    const smuggledRows =
      await sql`select id from received_emails where subject = ${`smuggled ${run}`}`;
    note(`probe row ${row.id}; rows with the smuggled subject: ${smuggledRows.length}`);
    assert.equal(smuggledRows.length, 0);
    const email = await ok<{ raw: { download_url: string } }>(
      apiA.emails.receiving.get(row.id),
      "get",
    );
    const raw = Buffer.from(await (await fetch(email.raw.download_url)).arrayBuffer()).toString();
    assert.ok(raw.includes(`MAIL FROM:<evil1@${SENDER}>`) && raw.includes("after"));
    note("the smuggled commands are message content");
  });

  await check("internal MX endpoints: wrong secret 401, right secret answers", async (note) => {
    const probe = (secret: string, recipient: string) =>
      fetch(`${API}/internal/mx/rcpt`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          recipient,
          mailFrom: "",
          clientIp: "192.0.2.1",
          helo: "probe.example",
        }),
      });
    const wrong = await probe("x".repeat(64), `x@${A_RECV}`);
    note(`wrong secret: ${wrong.status}`);
    assert.equal(wrong.status, 401);
    const right = await (await probe(ingestSecret, `x@${A_RECV}`)).json();
    const unknown = await (await probe(ingestSecret, "x@unknown-domain.example")).json();
    note(`right secret: ${JSON.stringify(right)}; unknown domain: ${JSON.stringify(unknown)}`);
    assert.equal(right.accept, true);
    assert.equal(unknown.accept, false);
    assert.equal(unknown.code, 550);
    const deliver = await fetch(`${API}/internal/mx/deliver`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(1024),
    });
    note(`deliver without a secret: ${deliver.status}`);
    assert.equal(deliver.status, 401);
  });

  await check(
    "instance enablement: without RECEIVING_MX_HOST receiving is invisible; partial config fails at boot",
    async (note) => {
      const { RECEIVING_MX_HOST: _host, MX_INGEST_SECRET: _secret, ...withoutReceiving } = appEnv;
      const api2 = { ...withoutReceiving, PROCESS: "api", PORT: String(PORTS.api2) };
      for (const [label, extra, expected] of [
        [
          "RECEIVING_MX_HOST without MX_INGEST_SECRET",
          { RECEIVING_MX_HOST: MX_HOST },
          /RECEIVING_MX_HOST and MX_INGEST_SECRET must be set together/,
        ],
        [
          "a 12-character MX_INGEST_SECRET",
          { RECEIVING_MX_HOST: MX_HOST, MX_INGEST_SECRET: "short-secret" },
          /MX_INGEST_SECRET must be at least 32 characters/,
        ],
      ] as const) {
        const attempt = await runUntil({ ...api2, ...extra }, /api listening on/);
        if (attempt.exited === null) attempt.child.kill("SIGTERM");
        note(
          `api with ${label}: exit=${attempt.exited}; ${attempt.output().match(expected)?.[0] ?? attempt.output().slice(-300)}`,
        );
        assert.notEqual(attempt.exited, null, "refuses to boot");
        assert.notEqual(attempt.exited, 0);
        assert.match(attempt.output(), expected);
      }
      const mxShort = await runUntil(
        { ...mxEnv, MX_INGEST_SECRET: "short-secret", MX_PORT: String(PORTS.api2) },
        /"event":"listening"/,
      );
      if (mxShort.exited === null) mxShort.child.kill("SIGTERM");
      note(
        `mx with a 12-character secret: exit=${mxShort.exited}; ${mxShort.output().match(/MX_INGEST_SECRET[^;\n]*/)?.[0]}`,
      );
      assert.notEqual(mxShort.exited, null);
      assert.notEqual(mxShort.exited, 0);

      const plain = await runUntil(api2, /api listening on/);
      assert.equal(plain.exited, null, `boots without receiving:\n${plain.output().slice(-1000)}`);
      try {
        const base = `http://127.0.0.1:${PORTS.api2}`;
        const rcpt = await fetch(`${base}/internal/mx/rcpt`, {
          method: "POST",
          headers: { authorization: `Bearer ${ingestSecret}`, "content-type": "application/json" },
          body: JSON.stringify({
            recipient: `x@${A_RECV}`,
            mailFrom: "",
            clientIp: "192.0.2.1",
            helo: "probe.example",
          }),
        });
        const deliver = await fetch(`${base}/internal/mx/deliver`, {
          method: "POST",
          headers: { authorization: `Bearer ${ingestSecret}` },
          body: "x",
        });
        note(`internal MX endpoints: rcpt ${rcpt.status}, deliver ${deliver.status}`);
        assert.equal(rcpt.status, 404);
        assert.equal(deliver.status, 404);
        const client = new Resend(apiA.key, { baseUrl: base });
        const got = await ok<{ capabilities: { receiving: string } }>(
          client.domains.get(domA),
          "domains.get",
        );
        const enable = await client.domains.update({
          id: domASend,
          capabilities: { receiving: "enabled" },
        });
        note(
          `${A_RECV} (receiving on in the database) reads receiving=${got.capabilities.receiving}; enabling ${A_SEND}: ${enable.error?.statusCode} ${enable.error?.message}`,
        );
        assert.equal(got.capabilities.receiving, "disabled");
        assert.equal(enable.error?.statusCode, 422);
        const list = await ok<{ data: unknown[] }>(
          client.emails.receiving.list({ limit: 1 }),
          "list",
        );
        note(`mail stored earlier stays readable: list returned ${list.data.length} item`);
      } finally {
        const exited = once(plain.child, "exit");
        plain.child.kill("SIGTERM");
        await exited;
      }
    },
  );

  await check("no message content in the process logs; no unexpected AWS calls", async (note) => {
    for (const name of ["api", "worker", "mx"] as const) {
      for (const needle of [
        CANARY_BODY,
        CANARY_SUBJECT,
        "Relatório de março",
        "fatura-mar",
        "Promoção",
        "grafico.png",
        "dados.bin",
      ]) {
        assert.ok(!logs[name].includes(needle), `${name} log mentions ${needle}`);
      }
      note(`${name}.log: ${logs[name].length} bytes, no subject, body or filename`);
    }
    note(`fake AWS calls outside SES/KMS: ${JSON.stringify(awsUnexpected)}`);
    assert.deepEqual(awsUnexpected, []);
  });

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  console.error("harness failed before or between cases:", err);
  results.push({
    name: "harness",
    ok: false,
    ms: 0,
    evidence: [],
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
} finally {
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify({ run, out, results, sesSends: sesSends.length, hooks: hooks.length }, null, 2),
  );
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed; report: ${join(out, "report.json")}`);
  for (const name of ["mx", "worker", "api"] as const) await stop(name);
  await sql.end({ timeout: 5 });
  docker(["rm", "-f", PG_CONTAINER]);
  fakeAws.close();
  hookServer.close();
}
process.exit(exitCode);
