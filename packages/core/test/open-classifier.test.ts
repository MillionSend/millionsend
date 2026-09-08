import { describe, expect, it } from "vitest";
import { classifyOpen } from "../src/open-classifier.js";

const at = new Date("2026-09-05T12:00:10.000Z");
const delivered = (secondsBefore: number) => ({
  at: new Date(at.getTime() - secondsBefore * 1000),
  delivered: true,
});
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const GMAIL_PROXY =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
const GMAIL_PREFETCH =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0";

describe("classifyOpen", () => {
  it.each([
    [
      "Apple Mail Privacy Protection's bare user agent, hours later",
      "Mozilla/5.0",
      delivered(3600),
      "apple_mpp",
    ],
    ["Gmail's prefetch user agent", GMAIL_PREFETCH, delivered(2), "gmail_prefetch"],
    ["an empty user agent", "", delivered(600), "scanner"],
    [
      "a crawler token",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      delivered(600),
      "scanner",
    ],
    [
      "a security gateway token",
      "Mozilla/5.0 (compatible; Proofpoint URL Defense)",
      delivered(600),
      "scanner",
    ],
    [
      "a desktop Chrome user agent carrying a build number no browser sends",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.163 Safari/537.36",
      delivered(45),
      "spoofed_ua",
    ],
    [
      "the same forged build on a Mac platform",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.0 Safari/537.36",
      delivered(3600),
      "spoofed_ua",
    ],
    [
      "headless Chrome naming itself",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.163 Safari/537.36",
      delivered(600),
      "scanner",
    ],
    [
      "a fetch before the delivery report",
      IPHONE,
      { at: new Date(at.getTime() + 5000), delivered: true },
      "before_delivery",
    ],
    ["a fetch inside the window after delivery", IPHONE, delivered(3), "timing"],
    [
      "a fetch inside the window after the send, delivery not yet reported",
      IPHONE,
      { at: new Date(at.getTime() - 3000), delivered: false },
      "timing",
    ],
  ])("marks %s as a prefetch", (_label, userAgent, anchor, reason) => {
    expect(classifyOpen({ userAgent, at, anchor, windowMs: 10_000 })).toEqual({
      prefetched: true,
      reason,
    });
  });

  it.each([
    ["a phone reading past the window", IPHONE, delivered(45)],
    ["Gmail's image proxy rendering for a person", GMAIL_PROXY, delivered(45)],
    [
      "Outlook's ms-office proxy",
      "Mozilla/4.0 (compatible; ms-office; MSOffice 16)",
      delivered(120),
    ],
    [
      "a Cubot handset's WebView",
      "Mozilla/5.0 (Linux; Android 11; CUBOT KINGKONG 5 Pro Build/RP1A.200720.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.129 Mobile Safari/537.36",
      delivered(45),
    ],
    ["a fast fetch with no known send or delivery moment", IPHONE, null],
    [
      "a current desktop Chrome, reduced to major.0.0.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      delivered(45),
    ],
    [
      "an old but reduced desktop Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      delivered(45),
    ],
    [
      "Edge on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
      delivered(45),
    ],
    [
      "an Electron mail client, which keeps the full build",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Mailspring/1.22.0 Chrome/146.0.7680.216 Electron/39.0.0 Safari/537.36",
      delivered(45),
    ],
    [
      "a QtWebEngine mail client, which keeps the full build",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/6.7.2 Chrome/118.0.5993.220 Safari/537.36",
      delivered(45),
    ],
    [
      "a phone's Chrome, which was never reduced on Android 6",
      "Mozilla/5.0 (Linux; Android 6.0.1; SM-G920F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.5249.126 Mobile Safari/537.36",
      delivered(45),
    ],
    [
      "Chrome on iOS, which reports its full build",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.7977.64 Mobile/15E148 Safari/604.1",
      delivered(45),
    ],
    [
      "a desktop Chrome from before the reduction",
      "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36",
      delivered(45),
    ],
  ])("keeps %s as an open", (_label, userAgent, anchor) => {
    expect(classifyOpen({ userAgent, at, anchor, windowMs: 10_000 })).toEqual({
      prefetched: false,
    });
  });

  it("turns the timing rule off at window 0 but keeps the user-agent rules", () => {
    expect(classifyOpen({ userAgent: IPHONE, at, anchor: delivered(1), windowMs: 0 })).toEqual({
      prefetched: false,
    });
    expect(
      classifyOpen({ userAgent: "Mozilla/5.0", at, anchor: delivered(1), windowMs: 0 }),
    ).toEqual({ prefetched: true, reason: "apple_mpp" });
  });
});
