import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { parseClamdReply, scanWithClamd } from "../src/receiving/clamd.js";

// Built at runtime so this file itself never matches an antivirus signature.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(
  "",
);

/** A fake clamd speaking INSTREAM framing, with a StreamMaxLength. */
function fakeClamd(opts: { maxBytes?: number; silent?: boolean } = {}): Promise<Server> {
  const maxBytes = opts.maxBytes ?? 1 << 20;
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let commandSeen = false;
    let body = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!commandSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        if (buf.subarray(0, nul).toString() !== "zINSTREAM") socket.destroy();
        buf = buf.subarray(nul + 1);
        commandSeen = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          if (opts.silent) return;
          socket.end(
            body.includes(Buffer.from(EICAR))
              ? "stream: Eicar-Test-Signature FOUND\0"
              : "stream: OK\0",
          );
          return;
        }
        if (buf.length < 4 + len) return;
        body = Buffer.concat([body, buf.subarray(4, 4 + len)]);
        buf = buf.subarray(4 + len);
        if (body.length > maxBytes) {
          socket.end("INSTREAM size limit exceeded. ERROR\0");
          return;
        }
      }
    });
    socket.on("error", () => {});
  });
  server.unref();
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const msg = (body: string) => Buffer.from(`From: a@x.example\r\nSubject: t\r\n\r\n${body}\r\n`);
const portOf = (server: Server) => (server.address() as { port: number }).port;

describe("scanWithClamd", () => {
  it("passes clean mail and fails EICAR with its signature", async () => {
    const server = await fakeClamd();
    const scan = (raw: Buffer) =>
      scanWithClamd(raw, {
        host: `127.0.0.1:${portOf(server)}`,
        timeoutMs: 5_000,
        maxBytes: 1 << 20,
      });
    expect(await scan(msg("hello"))).toEqual({ verdict: "pass" });
    expect(await scan(msg(EICAR))).toEqual({ verdict: "fail", signature: "Eicar-Test-Signature" });
    server.close();
  });

  it("never passes what clamd could not read: its size limit, ours, a silent server, a refused port", async () => {
    const server = await fakeClamd({ maxBytes: 200_000 });
    const host = `127.0.0.1:${portOf(server)}`;
    const big = await scanWithClamd(Buffer.alloc(1_000_000, 65), {
      host,
      timeoutMs: 5_000,
      maxBytes: 2_000_000,
    });
    expect(big.verdict).toBe("processing_failed");
    expect(
      await scanWithClamd(Buffer.alloc(1_000_000, 65), {
        host,
        timeoutMs: 5_000,
        maxBytes: 100_000,
      }),
    ).toEqual({
      verdict: "processing_failed",
      reason: "too_large",
    });
    server.close();
    const quiet = await fakeClamd({ silent: true });
    expect(
      await scanWithClamd(msg("x"), {
        host: `127.0.0.1:${portOf(quiet)}`,
        timeoutMs: 300,
        maxBytes: 1 << 20,
      }),
    ).toEqual({ verdict: "processing_failed", reason: "timeout" });
    quiet.close();
    const refused = await scanWithClamd(msg("x"), {
      host: "127.0.0.1:1",
      timeoutMs: 2_000,
      maxBytes: 1 << 20,
    });
    expect(refused.verdict).toBe("processing_failed");
  });

  it("parses clamd's reply records", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ verdict: "pass" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND")).toEqual({
      verdict: "fail",
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(parseClamdReply("garbage")).toEqual({
      verdict: "processing_failed",
      reason: "unexpected_reply",
    });
  });
});
