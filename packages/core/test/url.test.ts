import { describe, expect, it } from "vitest";
import { unwrapRedirect, withLibpqSslmode } from "../src/url.js";

const target = "https://login.lure.example/path?a=1&b=2";
const encoded = encodeURIComponent(target);

describe("unwrapRedirect", () => {
  it("parses a long crafted Proofpoint v3 href in linear time", () => {
    const crafted = `https://urldefense.com/v3/__${"__;".repeat(50_000)}`;
    expect(unwrapRedirect(crafted)).toBe(crafted);
  });

  it("decodes each well-known wrapper one level, without a visit", () => {
    const wrapped: [string, string, string][] = [
      ["Google /url?q=", `https://www.google.com/url?q=${encoded}&sa=D&ust=1`, target],
      ["Google /url?url=", `https://google.com/url?url=${encoded}`, target],
      ["a Google country domain", `https://www.google.com.br/url?q=${encoded}`, target],
      [
        "Google's AMP viewer",
        "https://www.google.com/amp/s/news.lure.example/a/1?x=2",
        "https://news.lure.example/a/1?x=2",
      ],
      ["Facebook", `https://l.facebook.com/l.php?u=${encoded}&h=AT0`, target],
      ["Facebook mobile", `https://lm.facebook.com/l.php?u=${encoded}`, target],
      ["Messenger", `https://l.messenger.com/l.php?u=${encoded}`, target],
      ["Instagram", `https://l.instagram.com/?u=${encoded}&e=ATM`, target],
      [
        "Outlook Safe Links",
        `https://nam12.safelinks.protection.outlook.com/?url=${encoded}&data=05%7C01&reserved=0`,
        target,
      ],
      ["Proofpoint v1", `https://urldefense.proofpoint.com/v1/url?u=${encoded}&k=abc`, target],
      [
        "Proofpoint v2",
        "https://urldefense.proofpoint.com/v2/url?u=https-3A__login.lure.example_path-3Fa-3D1-26b-3D2&d=DwMFaQ&c=x&r=y&m=z&s=w&e=",
        target,
      ],
      [
        "Proofpoint v3",
        "https://urldefense.com/v3/__https://login.lure.example/a*b__;Iw!!AbCd!ef$",
        "https://login.lure.example/a#b",
      ],
      [
        "Proofpoint v3, a run",
        "https://urldefense.proofpoint.com/v3/__https://login.lure.example/x**Ay__;Pz0!!AbCd$",
        "https://login.lure.example/x?=y",
      ],
      [
        "YouTube",
        `https://www.youtube.com/redirect?event=video_description&q=${encoded}&v=x`,
        target,
      ],
      ["Reddit", `https://out.reddit.com/t3_abc?url=${encoded}&token=t`, target],
      ["LinkedIn", `https://www.linkedin.com/redir/redirect?url=${encoded}&urlhash=x`, target],
      ["LinkedIn's warning page", `https://www.linkedin.com/safety/go?url=${encoded}`, target],
      ["Slack", `https://slack-redir.net/link?url=${encoded}`, target],
      ["VK", `https://vk.com/away.php?to=${encoded}&cc_key=`, target],
      ["Steam", `https://steamcommunity.com/linkfilter/?url=${encoded}`, target],
      ["DuckDuckGo", `https://duckduckgo.com/l/?uddg=${encoded}&rut=x`, target],
      ["Barracuda", `https://linkprotect.cudasvc.com/url?a=${encoded}&c=E,1`, target],
      [
        "Mimecast, which names only the domain",
        "https://protect-us.mimecast.com/s/AbCdEfGh?domain=login.lure.example",
        "https://login.lure.example/",
      ],
    ];
    for (const [name, href, expected] of wrapped) expect(unwrapRedirect(href), name).toBe(expected);
  });

  it("leaves everything else as written", () => {
    for (const href of [
      `https://www.google.com/search?q=${encoded}`,
      `https://google.evil.example/url?q=${encoded}`,
      `https://www.google.com.evil.example/url?q=${encoded}`,
      `https://l.facebook.com.evil.example/l.php?u=${encoded}`,
      `https://evil.example/safelinks.protection.outlook.com/?url=${encoded}`,
      "https://www.google.com/url?q=javascript:alert(1)",
      "https://protect-us.mimecast.com/s/x?domain=not a host",
      "https://acme.dev/welcome",
      "mailto:help@acme.dev",
      "not a url",
    ]) {
      expect(unwrapRedirect(href), href).toBe(href);
    }
  });

  it("resolves a destination written relative to the wrapper, as its redirect would", () => {
    expect(unwrapRedirect("https://www.google.com/url?q=//evil.example/login")).toBe(
      "https://evil.example/login",
    );
    expect(unwrapRedirect("https://www.google.com/url?q=/maps/place")).toBe(
      "https://www.google.com/maps/place",
    );
  });

  it("decodes only one level", () => {
    const inner = `https://l.facebook.com/l.php?u=${encoded}`;
    expect(unwrapRedirect(`https://www.google.com/url?q=${encodeURIComponent(inner)}`)).toBe(inner);
  });
});

describe("withLibpqSslmode", () => {
  const db = "app:pw@db.example.com:5432/app";

  it("adds uselibpqcompat=true to prefer and require, on either scheme", () => {
    for (const url of [
      `postgres://${db}?sslmode=require`,
      `postgresql://${db}?sslmode=require`,
      `postgres://${db}?sslmode=prefer`,
    ]) {
      expect(withLibpqSslmode(url), url).toBe(`${url}&uselibpqcompat=true`);
    }
  });

  it("keeps the other parameters and the encoded credentials as written", () => {
    const url =
      "postgres://app%40corp:p%40ss%2Fw%3Ard@db.example.com:5432/app?application_name=ms&sslmode=require&options=-c%20search_path%3Dmail";
    expect(withLibpqSslmode(url)).toBe(`${url}&uselibpqcompat=true`);
  });

  it("leaves no sslmode, the verifying modes and an explicit uselibpqcompat as written", () => {
    for (const url of [
      `postgres://${db}`,
      `postgresql://${db}?application_name=ms`,
      `postgres://${db}?sslmode=verify-full`,
      `postgres://${db}?sslmode=verify-ca`,
      `postgres://${db}?sslmode=disable`,
      `postgres://${db}?sslmode=require&uselibpqcompat=false`,
      `postgres://${db}?uselibpqcompat=true&sslmode=require`,
      "postgres://app:pw@db.example.com:port/app?sslmode=require",
    ]) {
      expect(withLibpqSslmode(url), url).toBe(url);
    }
  });
});
