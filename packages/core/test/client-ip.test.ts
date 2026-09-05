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
