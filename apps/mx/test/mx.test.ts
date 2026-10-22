import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type DeliverEnvelope,
  decodeEnvelopeHeader,
  MX_ENVELOPE_HEADER,
} from "@millionsend/core/receiving-protocol";
import { type DNSResolver, dkimSign } from "mailauth";
import nodemailer from "nodemailer";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MxEnv } from "../src/env.js";
import { createMxServer, type MxOptions, type MxServer } from "../src/mx.js";

const SECRET = "s".repeat(40);

/** What the fake app saw: one entry per request to the internal MX API. */
interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
type Answer = { status: number; body?: unknown; location?: string } | "hang" | "reset";

const hits: Hit[] = [];
let answerRcpt: (hit: Hit) => Answer;
let answerDeliver: (hit: Hit) => Answer;

const ingest = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const hit = { path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
    hits.push(hit);
    const answer = hit.path.endsWith("/rcpt") ? answerRcpt(hit) : answerDeliver(hit);
    if (answer === "hang") return;
    if (answer === "reset") {
      req.socket.destroy();
      return;
    }
    res
      .writeHead(answer.status, {
        "content-type": "application/json",
        ...(answer.location ? { location: answer.location } : {}),
      })
      .end(JSON.stringify(answer.body ?? {}));
  });
});
let ingestUrl: string;

const nxdomain: DNSResolver = async () => {
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
};

const servers: MxServer[] = [];

async function startMx(
  env: Partial<MxEnv> = {},
  options: MxOptions = {},
): Promise<{ mx: MxServer; port: number }> {
  const mx = createMxServer(
    {
      ingestUrl,
      ingestSecret: SECRET,
      hostname: "mx.test",
      port: 0,
      tls: null,
      maxClients: 50,
      maxConnectionsPerIp: 10,
      connectionsPerIpPerMinute: 1000,
      maxRecipients: 50,
      socketTimeoutMs: 10_000,
      sessionTimeoutMs: 60_000,
      maxBufferedBytes: 64 * 1024 * 1024,
      ...env,
    },
    { resolver: nxdomain, ...options },
  );
  servers.push(mx);
  await new Promise<void>((resolve) => mx.smtp.listen(0, "127.0.0.1", resolve));
  return { mx, port: (mx.smtp.server.address() as AddressInfo).port };
}

/** A raw SMTP client: `send` writes one line and resolves with the whole (multi-line) reply. */
async function smtpClient(port: number) {
  const socket = connect(port, "127.0.0.1");
  const lines: string[] = [];
  let partial = "";
  let closed = false;
  let wake: (() => void) | null = null;
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    partial += data;
    for (let eol = partial.indexOf("\r\n"); eol !== -1; eol = partial.indexOf("\r\n")) {
      lines.push(partial.slice(0, eol));
      partial = partial.slice(eol + 2);
    }
    wake?.();
  });
  socket.on("close", () => {
    closed = true;
    wake?.();
  });
  socket.on("error", () => {});
  const reply = async (): Promise<string> => {
    const out: string[] = [];
    for (;;) {
      for (let line = lines.shift(); line !== undefined; line = lines.shift()) {
        out.push(line);
        if (/^\d{3} /.test(line)) return out.join("\n");
      }
      if (closed) return out.length > 0 ? out.join("\n") : "(closed)";
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  };
  const greeting = await reply();
  return {
    greeting,
    socket,
    reply,
    send: (line: string) => {
      socket.write(`${line}\r\n`);
      return reply();
    },
    write: (data: string) => socket.write(data),
    isClosed: () => closed,
    close: async () => {
      if (closed) return;
      socket.end();
      await once(socket, "close");
    },
  };
}

const MESSAGE = [
  "From: Sender <sender@sender.test>",
  "To: someone@acme.test",
  "Subject: Quarterly secret plans",
  "Message-ID: <m1@sender.test>",
  "",
  "Body line with the launch code 7731",
  ".a line that starts with a dot",
].join("\r\n");

/** DATA payload as a client sends it: dot-stuffed and terminated. */
const onTheWire = (message: string) => `${message.replace(/^\./gm, "..")}\r\n.`;

/** One full transaction; returns every reply and the client, already closed. */
async function transaction(
  port: number,
  { to = ["someone@acme.test"], message = MESSAGE }: { to?: string[]; message?: string } = {},
) {
  const c = await smtpClient(port);
  const ehlo = await c.send("EHLO client.test");
  const mail = await c.send("MAIL FROM:<sender@sender.test>");
  const rcpts: string[] = [];
  for (const recipient of to) rcpts.push(await c.send(`RCPT TO:<${recipient}>`));
  const data = await c.send("DATA");
  const done = data.startsWith("354") ? await c.send(onTheWire(message)) : null;
  if (!c.isClosed()) await c.send("QUIT");
  await c.close();
  return { ehlo, mail, rcpts, data, done };
}

const deliveries = () => hits.filter((hit) => hit.path.endsWith("/deliver"));
const rcptCalls = () => hits.filter((hit) => hit.path.endsWith("/rcpt"));
const envelopeOf = (hit: Hit): DeliverEnvelope | null =>
  decodeEnvelopeHeader(hit.headers[MX_ENVELOPE_HEADER] as string | undefined);

beforeAll(async () => {
  await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
  ingestUrl = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}/internal/mx`;
});

beforeEach(() => {
  hits.length = 0;
  answerRcpt = () => ({ status: 200, body: { accept: true, ttlSeconds: 30 } });
  answerDeliver = () => ({ status: 200, body: { stored: 1 } });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((mx) => mx.close()));
});

afterAll(async () => {
  ingest.closeAllConnections();
  await new Promise<void>((resolve) => ingest.close(() => resolve()));
});

describe("mx session", () => {
  it("hands the raw message to the app and answers 250 once the app stored it", async () => {
    const { port } = await startMx();
    const { done } = await transaction(port);
    expect(done).toMatch(/^250 Message accepted \(\w+\)$/);

    const [rcpt] = rcptCalls();
    expect(rcpt?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(rcpt?.body.toString() ?? "")).toEqual({
      recipient: "someone@acme.test",
      mailFrom: "sender@sender.test",
      clientIp: "127.0.0.1",
      helo: "client.test",
    });

    const [deliver] = deliveries();
    expect(deliver?.path).toBe("/internal/mx/deliver");
    expect(deliver?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(deliver?.headers["content-type"]).toBe("application/octet-stream");
    // Unmodified: dot-unstuffed, nothing prepended, the final CRLF kept.
    expect(deliver?.body.toString()).toBe(`${MESSAGE}\r\n`);
    const envelope = deliver ? envelopeOf(deliver) : null;
    expect(envelope).toMatchObject({
      mailFrom: "sender@sender.test",
      recipients: ["someone@acme.test"],
      clientIp: "127.0.0.1",
      helo: "client.test",
      tls: null,
      auth: { spf: "none", dkim: "none", dmarc: "none", arc: "none" },
    });
    expect(Date.parse(envelope?.receivedAt ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  it("gates the transaction: nothing reaches the app out of order", async () => {
    const { port } = await startMx();
    const c = await smtpClient(port);
    expect(c.greeting).toBe("220 mx.test ESMTP");
    expect(await c.send("MAIL FROM:<sender@sender.test>")).toMatch(/^503 /);
    await c.send("EHLO client.test");
    expect(await c.send("RCPT TO:<someone@acme.test>")).toMatch(/^503 Error: need MAIL/);
    expect(await c.send("DATA")).toMatch(/^503 /);
    expect(await c.send("MAIL FROM:<sender@sender.test> SIZE=99999999999")).toMatch(/^552 /);
    await c.send("QUIT");
    await c.close();
    expect(hits).toEqual([]);
  });

  it("refuses unknown domains with 550 5.1.1 and never opens DATA (no relay)", async () => {
    answerRcpt = () => ({
      status: 200,
      body: {
        accept: false,
        code: 550,
        enhanced: "5.1.1",
        message: "Recipient domain does not receive mail here",
        ttlSeconds: 60,
      },
    });
    const { port } = await startMx();
    const { rcpts, data } = await transaction(port, { to: ["someone@gmail.com"] });
    expect(rcpts).toEqual(["550 5.1.1 Recipient domain does not receive mail here"]);
    expect(data).toMatch(/^503 Error: need RCPT command/);
    expect(deliveries()).toEqual([]);
  });

  it("passes the quota answer through as 452 4.2.2", async () => {
    answerRcpt = () => ({
      status: 200,
      body: {
        accept: false,
        code: 452,
        enhanced: "4.2.2",
        message: "Recipient account is over its receiving limit, try again later",
        ttlSeconds: 30,
      },
    });
    const { port } = await startMx();
    const { rcpts } = await transaction(port);
    expect(rcpts).toEqual([
      "452 4.2.2 Recipient account is over its receiving limit, try again later",
    ]);
  });

  it("answers 451 4.3.0 at RCPT when the app is unreachable or answers nonsense", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const dead = await startMx({ ingestUrl: `http://127.0.0.1:${deadPort}/internal/mx` });
    const temporary = "451 4.3.0 Temporary local problem, please try again later";
    expect((await transaction(dead.port)).rcpts).toEqual([temporary]);

    const { port } = await startMx();
    answerRcpt = () => ({ status: 500, body: { error: "boom" } });
    expect((await transaction(port, { to: ["a@one.test"] })).rcpts).toEqual([temporary]);
    answerRcpt = () => ({ status: 200, body: { accept: "yes" } });
    expect((await transaction(port, { to: ["a@two.test"] })).rcpts).toEqual([temporary]);
    // A 404 is how a disabled instance answers.
    answerRcpt = () => ({ status: 404 });
    expect((await transaction(port, { to: ["a@three.test"] })).rcpts).toEqual([temporary]);
  });

  it("reuses an answer per recipient domain for its ttl, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { port } = await startMx();
    await transaction(port, { to: ["a@acme.test", "b@ACME.test"] });
    await transaction(port, { to: ["c@acme.test"] });
    expect(rcptCalls()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 31_000);
    await transaction(port, { to: ["d@acme.test"] });
    expect(rcptCalls()).toHaveLength(2);

    answerRcpt = () => ({ status: 200, body: { accept: true, ttlSeconds: 0 } });
    await transaction(port, { to: ["a@uncached.test", "b@uncached.test"] });
    expect(rcptCalls()).toHaveLength(4);
  });

  it("caps recipients per message and the envelope header's byte budget", async () => {
    const small = await startMx({ maxRecipients: 2 });
    const capped = await transaction(small.port, {
      to: ["a@acme.test", "b@acme.test", "c@acme.test"],
    });
    expect(capped.rcpts[2]).toBe("452 4.5.3 Too many recipients");
    expect(capped.done).toMatch(/^250 /);
    expect(envelopeOf(deliveries()[0] as Hit)?.recipients).toEqual(["a@acme.test", "b@acme.test"]);

    hits.length = 0;
    const { port } = await startMx({ maxRecipients: 100 });
    // 252 JSON bytes each: 32 fit in 8 KiB, the 33rd would not.
    const long = Array.from({ length: 33 }, (_, i) => `${"x".repeat(237)}${100 + i}@acme.test`);
    const budget = await transaction(port, { to: long });
    expect(budget.rcpts.filter((r) => r.startsWith("250"))).toHaveLength(32);
    expect(budget.rcpts[32]).toBe("452 4.5.3 Too many recipients");
    expect(budget.done).toMatch(/^250 /);
    expect(envelopeOf(deliveries()[0] as Hit)?.recipients).toHaveLength(32);
  });

  it("drops a session that keeps collecting refused recipients", async () => {
    answerRcpt = () => ({
      status: 200,
      body: { accept: false, code: 550, enhanced: "5.1.1", message: "Unknown", ttlSeconds: 60 },
    });
    const { port } = await startMx();
    const c = await smtpClient(port);
    await c.send("EHLO client.test");
    await c.send("MAIL FROM:<sender@sender.test>");
    for (let i = 0; i < 20; i++) expect(await c.send(`RCPT TO:<a@d${i}.test>`)).toMatch(/^550 /);
    expect(await c.send("RCPT TO:<a@last.test>")).toMatch(/^421 4\.7\.0 /);
    await once(c.socket, "close");
  });

  it("offers neither AUTH nor STARTTLS without a keypair, and advertises SIZE", async () => {
    const { port } = await startMx();
    const c = await smtpClient(port);
    const ehlo = await c.send("EHLO client.test");
    expect(ehlo).toContain("SIZE 41943040");
    expect(ehlo).not.toMatch(/AUTH|STARTTLS/);
    expect(await c.send("AUTH PLAIN AGJvYgBwYXNz")).toMatch(/^500 /);
    expect(await c.send("STARTTLS")).toMatch(/^500 /);
    await c.send("QUIT");
    await c.close();
  });

  /** A message of about `size` bytes, under any cap below it. */
  const sized = (size: number) => `${MESSAGE}\r\n${"b".repeat(size - MESSAGE.length - 2)}`;

  it("refuses an oversized message with 552 5.3.4, dropping it while it streams", async () => {
    const { port } = await startMx({ maxBufferedBytes: 4096 }, { maxMessageBytes: 2048 });
    const oversized = await smtpClient(port);
    await oversized.send("EHLO client.test");
    await oversized.send("MAIL FROM:<sender@sender.test>");
    await oversized.send("RCPT TO:<someone@acme.test>");
    await oversized.send("DATA");
    oversized.write(`${"y".repeat(78)}\r\n`.repeat(38));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 3 KiB are in: past the cap, under the 4 KiB budget. Kept, they would
    // leave this 1.5 KiB message no room.
    expect((await transaction(port, { message: sized(1500) })).done).toMatch(/^250 /);
    expect(await oversized.send("\r\n.")).toBe(
      "552 5.3.4 Message size exceeds fixed maximum message size",
    );
    await oversized.send("QUIT");
    await oversized.close();
    expect(deliveries()).toHaveLength(1);
    const big = sized(100_000);
    for (let i = 0; i < 3; i++) {
      expect((await transaction(port, { message: big })).done).toMatch(/^552 /);
    }
    expect((await transaction(port, { message: sized(1500) })).done).toMatch(/^250 /);
  });

  it("answers 452 4.3.1 when every session together would hold too much", async () => {
    const { port } = await startMx({ maxBufferedBytes: 4096 });
    const { done } = await transaction(port, { message: sized(8192) });
    expect(done).toBe("452 4.3.1 Insufficient system storage, try again later");
    expect(deliveries()).toEqual([]);

    // A client that hangs up mid-DATA frees what it held.
    const c = await smtpClient(port);
    await c.send("EHLO client.test");
    await c.send("MAIL FROM:<sender@sender.test>");
    await c.send("RCPT TO:<someone@acme.test>");
    await c.send("DATA");
    c.write(`${"x".repeat(78)}\r\n`.repeat(38));
    await new Promise((resolve) => setTimeout(resolve, 50));
    c.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // And so does every handoff, delivered or not.
    for (let i = 0; i < 3; i++) {
      expect((await transaction(port, { message: sized(1500) })).done).toMatch(/^250 /);
    }
    answerDeliver = () => ({ status: 503 });
    for (let i = 0; i < 3; i++) {
      expect((await transaction(port, { message: sized(1500) })).done).toMatch(/^451 /);
    }
    answerDeliver = () => ({ status: 200 });
    expect((await transaction(port, { message: sized(1500) })).done).toMatch(/^250 /);
  });

  it("logs the refusals it makes itself, envelope facts only", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    const capped = await startMx({ maxRecipients: 1 });
    expect((await transaction(capped.port, { to: ["a@acme.test", "b@acme.test"] })).rcpts[1]).toBe(
      "452 4.5.3 Too many recipients",
    );
    const small = await startMx({}, { maxMessageBytes: 2048 });
    expect((await transaction(small.port, { message: sized(3000) })).done).toMatch(/^552 /);
    const tight = await startMx({ maxBufferedBytes: 4096 });
    expect((await transaction(tight.port, { message: sized(8192) })).done).toMatch(/^452 /);

    const events = lines.map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "rcpt_refused",
        domain: "acme.test",
        code: 452,
        reason: "recipient_limit",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "message_refused", reason: "size", ip: "127.0.0.1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "message_refused", reason: "memory" }),
    );
    expect(lines.join("\n")).not.toContain("secret plans");
  });

  it.each<[string, Answer, string]>([
    [
      "a 5xx",
      { status: 503, body: {} },
      "451 4.3.0 Temporary local problem, please try again later",
    ],
    ["a dropped connection", "reset", "451 4.3.0 Temporary local problem, please try again later"],
    ["a timeout", "hang", "451 4.3.0 Temporary local problem, please try again later"],
    [
      "a 422 without a reply",
      { status: 422, body: { code: 554 } },
      "451 4.3.0 Temporary local problem, please try again later",
    ],
    [
      "a permanent rejection",
      {
        status: 422,
        body: { code: 554, enhanced: "5.7.1", message: "Recipient account suspended" },
      },
      "554 5.7.1 Recipient account suspended",
    ],
    [
      "a quota refusal",
      { status: 429, body: { code: 452, enhanced: "4.2.2", message: "Over quota, try later" } },
      "452 4.2.2 Over quota, try later",
    ],
  ])("relays %s from /deliver to the client", async (_label, answer, expected) => {
    answerDeliver = () => answer;
    const { port } = await startMx({}, { deliverTimeoutMs: 300 });
    const { done } = await transaction(port);
    expect(done).toBe(expected);
    expect(deliveries()).toHaveLength(1);
  });

  it("never follows a redirect: a 302 turned GET would read as stored", async () => {
    answerDeliver = (hit) =>
      hit.path.endsWith("/deliver")
        ? { status: 302, location: `${ingestUrl}/moved` }
        : { status: 200 };
    const { port } = await startMx();
    expect((await transaction(port)).done).toMatch(/^451 4\.3\.0 /);
    expect(hits.map((hit) => hit.path)).toEqual(["/internal/mx/rcpt", "/internal/mx/deliver"]);
  });

  it("delivers with temperror verdicts when DNS stalls", async () => {
    const { port } = await startMx(
      {},
      { resolver: () => new Promise(() => {}), authTimeoutMs: 100 },
    );
    expect((await transaction(port)).done).toMatch(/^250 /);
    expect(envelopeOf(deliveries()[0] as Hit)?.auth).toEqual({
      spf: "temperror",
      dkim: "temperror",
      dmarc: "temperror",
      arc: "temperror",
    });
    // Unknown, so left out rather than made up.
    expect(envelopeOf(deliveries()[0] as Hit)).not.toHaveProperty("authDetail");
  });

  it("never ends DATA on a bare LF dot: smuggled commands stay message content", async () => {
    const { port } = await startMx();
    const smuggled = [
      "MAIL FROM:<ceo@sender.test>",
      "RCPT TO:<victim@acme.test>",
      "DATA",
      "Subject: smuggled",
      "",
      "forged",
    ].join("\r\n");
    const message = `${MESSAGE}\n.\n${smuggled}\r\n.\n${smuggled}\n.\r\n${smuggled}`;
    const c = await smtpClient(port);
    await c.send("EHLO client.test");
    await c.send("MAIL FROM:<sender@sender.test>");
    await c.send("RCPT TO:<someone@acme.test>");
    expect(await c.send("DATA")).toMatch(/^354 /);
    expect(await c.send(`${message}\r\n.`)).toMatch(/^250 Message accepted/);
    expect(await c.send("QUIT")).toMatch(/^221 /);
    await c.close();

    expect(rcptCalls()).toHaveLength(1);
    expect(deliveries()).toHaveLength(1);
    const raw = deliveries()[0]?.body.toString() ?? "";
    expect(raw).toBe(`${message}\r\n`);
    expect(raw).toContain("RCPT TO:<victim@acme.test>");
  });

  it("limits connections per address, per minute, and how long a session lasts", async () => {
    const { port } = await startMx({ maxConnectionsPerIp: 1, connectionsPerIpPerMinute: 3 });
    const first = await smtpClient(port);
    const second = await smtpClient(port);
    expect(second.greeting).toMatch(/^421 4\.7\.0 /);
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = await smtpClient(port);
    expect(third.greeting).toMatch(/^220 /);
    await third.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await smtpClient(port)).greeting).toMatch(/^421 4\.7\.0 /);

    const timed = await startMx({ sessionTimeoutMs: 300 });
    const slow = await smtpClient(timed.port);
    await slow.send("EHLO client.test");
    expect(await slow.reply()).toBe("421 4.4.2 Session time limit reached, closing connection");
  });

  it.each([
    {
      label: "an aligned signature under p=reject",
      signer: "sender.test",
      spf: "v=spf1 ip4:127.0.0.1 -all",
      policy: "reject",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      authDetail: {
        spf: { result: "pass", domain: "sender.test" },
        dkim: { aligned: ["sender.test"] },
        dmarc: { result: "pass", policy: "reject", domain: "sender.test" },
      },
    },
    {
      // A forged From signed by the forger's own domain: DKIM is valid, but not for From.
      label: "a valid signature from another domain than From's",
      signer: "forger.test",
      spf: "v=spf1 ip4:192.0.2.1 -all",
      policy: "reject",
      auth: { spf: "fail", dkim: "policy", dmarc: "fail", arc: "none" },
      authDetail: {
        spf: { result: "fail", domain: "sender.test" },
        dkim: { aligned: [] },
        dmarc: { result: "fail", policy: "reject", domain: "sender.test" },
      },
    },
    {
      // The folded verdict reads none; the detail keeps the pass and the policy.
      label: "a passing message from a p=none domain",
      signer: "sender.test",
      spf: "v=spf1 ip4:127.0.0.1 -all",
      policy: "none",
      auth: { spf: "pass", dkim: "pass", dmarc: "none", arc: "none" },
      authDetail: {
        spf: { result: "pass", domain: "sender.test" },
        dkim: { aligned: ["sender.test"] },
        dmarc: { result: "pass", policy: "none", domain: "sender.test" },
      },
    },
  ])(
    "hands SPF, DKIM and DMARC verdicts to the app: $label",
    async ({ signer, spf, policy, auth, authDetail }) => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const signed = await dkimSign(MESSAGE, {
        signatureData: [
          {
            signingDomain: signer,
            selector: "s1",
            privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
          },
        ],
      });
      const dkimKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const records: Record<string, string> = {
        "sender.test": spf,
        [`s1._domainkey.${signer}`]: `v=DKIM1; k=rsa; p=${dkimKey}`,
        "_dmarc.sender.test": `v=DMARC1; p=${policy}`,
      };
      const resolver: DNSResolver = async (name, type) => {
        const record = type === "TXT" ? records[name] : undefined;
        if (record) return [[record]];
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      };
      const { port } = await startMx({}, { resolver });
      expect((await transaction(port, { message: signed.signatures + MESSAGE })).done).toMatch(
        /^250 /,
      );
      expect(envelopeOf(deliveries()[0] as Hit)?.auth).toEqual(auth);
      expect(envelopeOf(deliveries()[0] as Hit)?.authDetail).toEqual(authDetail);
    },
  );

  it("skips authentication for a message carrying more DKIM signatures than it would check", async () => {
    const resolver = vi.fn(nxdomain);
    const { port } = await startMx({}, { resolver });
    const signatures = "DKIM-Signature: v=1; a=rsa-sha256; d=x.test; s=s; bh=; h=from; b=\r\n";
    await transaction(port, { message: signatures.repeat(11) + MESSAGE });
    expect(envelopeOf(deliveries()[0] as Hit)?.auth).toEqual({
      spf: "permerror",
      dkim: "permerror",
      dmarc: "permerror",
      arc: "permerror",
    });
    expect(envelopeOf(deliveries()[0] as Hit)).not.toHaveProperty("authDetail");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses a HELO name with control characters and cuts a long one before it travels or is stored", async () => {
    const { port } = await startMx();
    const c = await smtpClient(port);
    expect(await c.send("EHLO evil\u0000\u001b[31m.test")).toMatch(/^501 /);
    expect(await c.send(`EHLO ${"a".repeat(301)}`)).toMatch(/^501 /);
    await c.send(`EHLO ${"a".repeat(300)}`);
    await c.send("MAIL FROM:<>");
    await c.send("RCPT TO:<someone@acme.test>");
    await c.send("DATA");
    expect(await c.send(onTheWire(MESSAGE))).toMatch(/^250 /);
    await c.send("QUIT");
    await c.close();
    const envelope = envelopeOf(deliveries()[0] as Hit);
    expect(envelope?.mailFrom).toBe("");
    expect(envelope?.helo).toBe("a".repeat(255));
  });

  it("logs envelope facts and outcomes, never message content", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    answerRcpt = (hit) =>
      hit.body.includes("gmail")
        ? {
            status: 200,
            body: { accept: false, code: 550, enhanced: "5.1.1", message: "No", ttlSeconds: 60 },
          }
        : { status: 200, body: { accept: true, ttlSeconds: 30 } };
    const { port } = await startMx();
    await transaction(port, { to: ["someone@acme.test", "other@gmail.com"] });

    const events = lines.map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({ event: "rcpt_refused", domain: "gmail.com", code: 550 }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "delivered",
        from_domain: "sender.test",
        to_domains: ["acme.test"],
        bytes: MESSAGE.length + 2,
        spf: "none",
      }),
    );
    const all = lines.join("\n");
    for (const content of ["secret plans", "7731", "someone@", "sender@", "dot"]) {
      expect(all).not.toContain(content);
    }
  });
});

describe("mx STARTTLS", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-tls-"));
  const certPath = join(dir, "fullchain.pem");
  const keyPath = join(dir, "privkey.pem");
  let clock = Math.floor(Date.now() / 1000);

  const makeCert = (name: string) =>
    execFileSync(
      "openssl",
      [
        // P-256 generates in milliseconds; RSA key generation can stall a busy CI runner.
        ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"],
        ...["-nodes", "-days", "2", "-subj", `/CN=${name}`],
        ...["-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`)],
      ],
      { stdio: "ignore" },
    );
  /** Puts a keypair where the MX looks, with fresh mtimes like a certbot deploy hook. */
  const install = (certFrom: string, keyFrom: string) => {
    copyFileSync(join(dir, `${certFrom}.crt`), certPath);
    copyFileSync(join(dir, `${keyFrom}.key`), keyPath);
    clock += 10;
    utimesSync(certPath, clock, clock);
    utimesSync(keyPath, clock, clock);
  };

  /** The subject CN the server presents after STARTTLS. */
  async function presentedName(port: number): Promise<string | undefined> {
    const c = await smtpClient(port);
    await c.send("EHLO client.test");
    expect(await c.send("STARTTLS")).toMatch(/^220 /);
    c.socket.removeAllListeners("data");
    const secure = tlsConnect({ socket: c.socket, rejectUnauthorized: false });
    await once(secure, "secureConnect");
    const name = secure.getPeerCertificate().subject?.CN;
    secure.destroy();
    return Array.isArray(name) ? name[0] : name;
  }

  beforeAll(() => {
    makeCert("mx-a.test");
    makeCert("mx-b.test");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("turns STARTTLS on once a keypair appears and follows renewals without a restart", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    const { mx, port } = await startMx({ tls: { certPath, keyPath } });
    const before = await smtpClient(port);
    expect(await before.send("EHLO client.test")).not.toContain("STARTTLS");
    await before.close();

    install("mx-a.test", "mx-a.test");
    mx.reloadTls();
    const after = await smtpClient(port);
    expect(await after.send("EHLO client.test")).toContain("STARTTLS");
    await after.close();
    expect(await presentedName(port)).toBe("mx-a.test");

    install("mx-b.test", "mx-b.test");
    mx.reloadTls();
    expect(await presentedName(port)).toBe("mx-b.test");

    // A half-copied renewal (new cert, old key) keeps the working pair in place.
    install("mx-a.test", "mx-b.test");
    mx.reloadTls();
    expect(await presentedName(port)).toBe("mx-b.test");

    const events = lines.map((line) => JSON.parse(line).event);
    expect(events.filter((event) => event === "tls_loaded")).toHaveLength(2);
    expect(events).toContain("tls_unavailable");
  });

  it("tells the app the session's TLS version and cipher", async () => {
    install("mx-a.test", "mx-a.test");
    const { port } = await startMx({ tls: { certPath, keyPath } });
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      requireTLS: true,
      name: "client.test",
      tls: { rejectUnauthorized: false },
    });
    const info = await transport.sendMail({
      envelope: { from: "sender@sender.test", to: ["someone@acme.test"] },
      raw: MESSAGE,
    });
    transport.close();
    expect(info.response).toMatch(/^250 Message accepted/);
    const tls = envelopeOf(deliveries()[0] as Hit)?.tls;
    expect(tls?.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(tls?.cipher).toBeTruthy();
  });
});

describe("mx process", () => {
  it("boots with only MX_* variables and shuts down cleanly on SIGTERM", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const root = fileURLToPath(new URL("..", import.meta.url));
    // As scripts/start.mjs runs it: node with the package's tsx loader.
    const loader = createRequire(join(root, "package.json")).resolve("tsx");
    const tsx = ["--import", pathToFileURL(loader).href];
    const child = spawn(process.execPath, [...tsx, join(root, "src/server.ts")], {
      env: {
        PATH: process.env.PATH,
        MX_INGEST_URL: ingestUrl,
        MX_INGEST_SECRET: SECRET,
        MX_HOSTNAME: "mx.example.com",
        MX_PORT: String(port),
      },
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    await vi.waitFor(() => expect(output).toContain('"event":"listening"'), { timeout: 20_000 });
    const c = await smtpClient(port);
    expect(c.greeting).toBe("220 mx.example.com ESMTP");
    await c.send("QUIT");
    await c.close();
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(output).toContain('"event":"shutting_down"');
  }, 30_000);
});
