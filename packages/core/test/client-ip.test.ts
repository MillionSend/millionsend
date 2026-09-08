import { describe, expect, it } from "vitest";
import { forwardedClientIp } from "../src/client-ip.js";

const headers = (entries: Record<string, string>) => new Headers(entries);
const selfHost = { cloud: false, trustedProxies: ["127.0.0.1", "10.0.0.5"] };

describe("forwardedClientIp", () => {
  it("reads Cloudflare's single-value header on the cloud", () => {
    expect(
      forwardedClientIp(headers({ "cf-connecting-ip": "203.0.113.9" }), {
        cloud: true,
        trustedProxies: [],
      }),
    ).toBe("203.0.113.9");
    expect(
      forwardedClientIp(headers({ "x-forwarded-for": "203.0.113.9" }), {
        cloud: true,
        trustedProxies: [],
      }),
    ).toBeNull();
  });

  it("on the cloud, a declared proxy behind Cloudflare yields the client it forwarded", () => {
    // The tracking edge proxies branded links through Cloudflare, which then
    // names the edge as its peer and appends it to x-forwarded-for.
    const viaEdge = { cloud: true, trustedProxies: ["198.51.100.7"] };
    expect(
      forwardedClientIp(
        headers({
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "203.0.113.9, 198.51.100.7",
        }),
        viaEdge,
      ),
    ).toBe("203.0.113.9");
    // A chain the client itself started still resolves to the hop the edge saw.
    expect(
      forwardedClientIp(
        headers({
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "10.9.9.9, 203.0.113.9, 198.51.100.7",
        }),
        viaEdge,
      ),
    ).toBe("203.0.113.9");
    // The edge alone, with no chain behind it, names nobody.
    expect(forwardedClientIp(headers({ "cf-connecting-ip": "198.51.100.7" }), viaEdge)).toBeNull();
    // A direct visitor is still Cloudflare's peer, whatever x-forwarded-for says.
    expect(
      forwardedClientIp(
        headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "10.9.9.9" }),
        viaEdge,
      ),
    ).toBe("203.0.113.9");
  });

  it("walks x-forwarded-for from the right past the declared proxies", () => {
    expect(
      forwardedClientIp(
        headers({ "x-forwarded-for": "198.51.100.7, 203.0.113.9, 10.0.0.5" }),
        selfHost,
      ),
    ).toBe("203.0.113.9");
    expect(forwardedClientIp(headers({ "x-forwarded-for": "203.0.113.9" }), selfHost)).toBe(
      "203.0.113.9",
    );
  });

  it("returns null when nothing trustworthy is left", () => {
    expect(forwardedClientIp(headers({}), selfHost)).toBeNull();
    expect(forwardedClientIp(headers({ "x-forwarded-for": "10.0.0.5" }), selfHost)).toBeNull();
    expect(
      forwardedClientIp(headers({ "x-forwarded-for": "<script>alert(1)</script>" }), selfHost),
    ).toBeNull();
  });

  it("honors CIDR entries in the proxy list", () => {
    expect(
      forwardedClientIp(headers({ "x-forwarded-for": "203.0.113.9, 173.245.48.7" }), {
        cloud: false,
        trustedProxies: ["127.0.0.1", "::1", "173.245.48.0/20"],
      }),
    ).toBe("203.0.113.9");
  });
});
