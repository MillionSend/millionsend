import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getBytes,
  getImage,
  IMAGE_FETCH_MAX_BYTES,
  IMAGE_FETCH_TIMEOUT_MS,
  isBlockedIp,
  postFailureCode,
  postJson,
} from "../src/ssrf.js";

describe("isBlockedIp", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:0:7f00:1",
    "::7f00:1",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "2002:7f00:1::",
    "100::1",
    "2001:db8::1",
    "fec0::1",
    "ff02::1",
    // Any v4-in-v6 form is rejected, even for public addresses.
    "::ffff:8.8.8.8",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.128.0.1",
    "192.0.1.1",
    "198.17.0.1",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700::1111",
    "2001:1::1",
  ])("allows %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("postJson guard", () => {
  it("rejects non-https urls", async () => {
    await expect(postJson("http://example.com/hook", { body: "{}", headers: {} })).rejects.toThrow(
      /https/,
    );
  });

  it("rejects private IP-literal hosts before connecting", async () => {
    await expect(postJson("https://10.0.0.1/hook", { body: "{}", headers: {} })).rejects.toThrow(
      /blocked address/,
    );
    await expect(
      postJson("https://169.254.169.254/latest/meta-data", { body: "{}", headers: {} }),
    ).rejects.toThrow(/blocked address/);
    await expect(
      postJson("https://[::ffff:7f00:1]/hook", { body: "{}", headers: {} }),
    ).rejects.toThrow(/blocked address/);
  });

  it("rejects hostnames that resolve to a private address (pinned lookup)", async () => {
    // localhost resolves inside the same lookup the socket would use — the
    // rejection proves the resolved (not just literal) address is validated.
    await expect(postJson("https://localhost/hook", { body: "{}", headers: {} })).rejects.toThrow(
      /blocked address/,
    );
  });
});

describe("getBytes guard", () => {
  it("refuses http, private literals and names that resolve to them", async () => {
    await expect(getBytes("http://example.com/list", { maxBytes: 10 })).rejects.toThrow(/https/);
    await expect(getBytes("https://10.0.0.1/list", { maxBytes: 10 })).rejects.toThrow(
      /blocked address/,
    );
    await expect(getBytes("https://localhost/list", { maxBytes: 10 })).rejects.toThrow(
      /blocked address/,
    );
  });
});

describe("postJson delivery (allowLocalhost)", () => {
  let server: Server;
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("delivers to a hostname (pinned lookup feeds the socket's all-addresses form)", async () => {
    // A hostname (not an IP literal) routes through the custom lookup, which
    // the socket calls with `all: true` under autoSelectFamily (Node ≥20
    // default) — a single-address answer there breaks with "Invalid IP
    // address: undefined" and no hostname delivery ever succeeds.
    const base = await listen((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const port = new URL(base).port;
    const res = await postJson(`http://localhost:${port}/hook`, {
      body: "{}",
      headers: {},
      allowLocalhost: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("answers a NUL byte in the body as U+FFFD, which Postgres text can hold", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(500);
      res.end(Buffer.from([0x6f, 0x6b, 0x00, 0x21]));
    });
    const res = await postJson(`${base}/hook`, { body: "{}", headers: {}, allowLocalhost: true });
    expect(res.body).toBe("ok\uFFFD!");
  });

  it("POSTs, returns status, does not follow redirects, caps the body", async () => {
    const seen: { method?: string; body?: string; sigHeader?: string } = {};
    const base = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.method = req.method ?? "";
        seen.body = Buffer.concat(chunks).toString("utf8");
        seen.sigHeader = String(req.headers["webhook-signature"] ?? "");
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "/elsewhere" });
          res.end();
        } else {
          res.writeHead(200);
          res.end("x".repeat(20_000));
        }
      });
    });

    const res = await postJson(`${base}/hook`, {
      body: '{"a":1}',
      headers: { "webhook-signature": "v1,abc" },
      allowLocalhost: true,
    });
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"a":1}');
    expect(seen.sigHeader).toBe("v1,abc");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(8 * 1024);

    const redirect = await postJson(`${base}/redirect`, {
      body: "{}",
      headers: {},
      allowLocalhost: true,
    });
    expect(redirect.status).toBe(302);
  });
});

describe("postFailureCode", () => {
  it.each([
    [new Error("webhook url resolves to a blocked address"), "url_rejected"],
    [Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }), "dns_failed"],
    [
      Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }),
      "connection_refused",
    ],
    [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "connection_reset"],
    [Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }), "timeout"],
    [
      Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      "tls_failed",
    ],
    [new Error("something else"), "delivery_failed"],
  ] as const)("maps %s to a fixed code", (err, code) => {
    expect(postFailureCode(err)).toBe(code);
  });
});

describe("getImage", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  let server: Server;
  let base = "";
  let seen: IncomingHttpHeaders = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (status: number, headers: Record<string, string>, body?: Buffer | string) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      switch (req.url) {
        case "/hop":
          return send(302, { location: "/png" });
        case "/png":
          seen = req.headers;
          return send(200, { "content-type": "image/png; charset=binary" }, png);
        case "/private":
          return send(302, { location: "http://169.254.169.254/latest/meta-data" });
        case "/loop":
          return send(302, { location: "/loop" });
        case "/big-header":
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": String(IMAGE_FETCH_MAX_BYTES + 1),
          });
          return res.end();
        case "/big-stream":
          res.writeHead(200, { "content-type": "image/png" });
          res.write(png);
          return res.end(Buffer.alloc(IMAGE_FETCH_MAX_BYTES));
        case "/html":
          return send(200, { "content-type": "image/png" }, "<html><body>hi</body></html>");
        case "/slow":
          setTimeout(() => send(200, { "content-type": "image/png" }, png), 1_000);
          return;
        default:
          return send(404, {});
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const local = { allowLocalhost: true };

  it("refuses metadata, v4-mapped loopback and unique-local addresses before connecting", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://[::ffff:127.0.0.1]/logo.png",
      "https://[fc00::1]/logo.png",
    ]) {
      await expect(getImage(url), url).rejects.toThrow(/blocked address/);
    }
  });

  it("refuses ports other than 80 and 443, and schemes other than http(s)", async () => {
    await expect(getImage("http://example.com:8080/logo.png")).rejects.toThrow(/port/);
    await expect(getImage("ftp://example.com/logo.png")).rejects.toThrow(/http or https/);
  });

  it("follows a redirect as a desktop browser, with no cookie or referer", async () => {
    const image = await getImage(`${base}/hop`, local);
    expect(image).toEqual({ bytes: png, contentType: "image/png" });
    expect(seen["user-agent"]).toMatch(/^Mozilla\/5\.0 \(Windows NT/);
    expect(seen.cookie).toBeUndefined();
    expect(seen.referer).toBeUndefined();
  });

  it("checks every hop again: a redirect to a private address is refused", async () => {
    await expect(getImage(`${base}/private`, local)).rejects.toThrow(/blocked address/);
    await expect(getImage(`${base}/loop`, local)).rejects.toThrow(/too many/);
  });

  it("refuses an image over 5 MB, by its header or by its stream", async () => {
    await expect(getImage(`${base}/big-header`, local)).rejects.toThrow(/over/);
    await expect(getImage(`${base}/big-stream`, local)).rejects.toThrow(/over/);
  });

  it("refuses bytes that are not the image the header claims", async () => {
    await expect(getImage(`${base}/html`, local)).rejects.toThrow(
      /something other than image\/png/,
    );
  });

  it("gives up on a slow host", async () => {
    expect(IMAGE_FETCH_TIMEOUT_MS).toBe(3_000);
    const failure = await getImage(`${base}/slow`, { ...local, timeoutMs: 100 }).catch((e) => e);
    expect(postFailureCode(failure)).toBe("timeout");
  });
});
