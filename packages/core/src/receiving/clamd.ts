import { once } from "node:events";
import { connect } from "node:net";

export type VirusResult =
  | { verdict: "pass" }
  | { verdict: "fail"; signature: string }
  | { verdict: "processing_failed"; reason: string };

const DEFAULT_PORT = 3310;
const CHUNK_BYTES = 64 * 1024;
const MAX_REPLY = 4096;

/** clamd's reply record: "stream: OK", "stream: <signature> FOUND", or an error ending in ERROR. */
export function parseClamdReply(record: string): VirusResult {
  const t = record.replace(/\0+$/, "").trim();
  if (t === "stream: OK") return { verdict: "pass" };
  const found = /^stream: (.{1,200}) FOUND$/.exec(t);
  if (found) return { verdict: "fail", signature: found[1] as string };
  return {
    verdict: "processing_failed",
    reason: /ERROR$/.test(t) ? t.slice(0, 120) : "unexpected_reply",
  };
}

/** "host", "host:port" or "[v6]:port". */
function hostPort(value: string): { host: string; port: number } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (v6) return { host: v6[1] as string, port: v6[2] ? Number(v6[2]) : DEFAULT_PORT };
  const colon = value.lastIndexOf(":");
  if (colon > 0 && value.indexOf(":") === colon) {
    return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) || DEFAULT_PORT };
  }
  return { host: value, port: DEFAULT_PORT };
}

/**
 * clamd INSTREAM over TCP: "zINSTREAM\0", chunks each led by a 4-byte
 * big-endian length, a zero-length chunk, then one NUL-terminated reply
 * (https://docs.clamav.net/manual/Usage/ClamdProtocol.html). The raw RFC 822
 * message goes as is: clamd decodes MIME itself. Never throws: a failure is
 * processing_failed. Input past maxBytes is refused before connecting, since
 * past clamd's StreamMaxLength the writer often sees only a broken pipe.
 */
export function scanWithClamd(
  raw: Buffer,
  p: { host: string; timeoutMs: number; maxBytes: number },
): Promise<VirusResult> {
  if (raw.length > p.maxBytes) {
    return Promise.resolve({ verdict: "processing_failed", reason: "too_large" });
  }
  const { host, port } = hostPort(p.host);
  return new Promise((resolve) => {
    let reply = "";
    let settled = false;
    const socket = connect({ host, port });
    const finish = (result: VirusResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(p.timeoutMs, () =>
      finish({ verdict: "processing_failed", reason: "timeout" }),
    );
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("latin1");
      const nul = reply.indexOf("\0");
      if (nul >= 0) finish(parseClamdReply(reply.slice(0, nul)));
      else if (reply.length > MAX_REPLY)
        finish({ verdict: "processing_failed", reason: "reply_too_long" });
    });
    // clamd answers a size-limit error and closes while the stream is still
    // being written: its reply, when one arrived, wins over the broken pipe.
    socket.on("error", (err: NodeJS.ErrnoException) =>
      finish(
        reply
          ? parseClamdReply(reply)
          : { verdict: "processing_failed", reason: err.code ?? "error" },
      ),
    );
    socket.on("end", () =>
      finish(reply ? parseClamdReply(reply) : { verdict: "processing_failed", reason: "no_reply" }),
    );
    socket.once("connect", async () => {
      try {
        socket.write("zINSTREAM\0");
        for (let i = 0; i < raw.length && !settled; i += CHUNK_BYTES) {
          const chunk = raw.subarray(i, i + CHUNK_BYTES);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          if (!socket.write(Buffer.concat([length, chunk]))) await once(socket, "drain");
        }
        if (!settled) socket.write(Buffer.alloc(4));
      } catch {
        // The error or close handler settles.
      }
    });
  });
}
