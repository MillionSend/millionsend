import type { ErrorEvent, StreamedSpanJSON } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { generateApiKey } from "../src/api-keys.js";
import {
  errorTrackingOptions,
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
  scrubText,
} from "../src/error-tracking.js";

const KEY = generateApiKey().token;
// Shaped like an unsubscribe token: base64url(payload).base64url(mac), the
// payload naming the recipient.
const TOKEN = [JSON.stringify({ t: "abc", e: "john@x.com" }), "mac"]
  .map((part) => Buffer.from(part).toString("base64url"))
  .join(".");
const ID = "3f1c2b7e-0a4d-4c6e-9b1a-2d3e4f5a6b7c";

describe("scrubText", () => {
  it("keeps an address's domain and masks its local part and every API key", () => {
    expect(scrubText(`bounce for john.doe+x@example.com, key ${KEY}`)).toBe(
      "bounce for ••••••@example.com, key ••••••",
    );
  });

  it("drops a URL's query and fragment, where a tRPC call carries its input", () => {
    expect(
      scrubText(
        'GET https://app.example.com/api/trpc/emails.list?batch=1&input={"email":"a@b.co"}#x failed',
      ),
    ).toBe("GET https://app.example.com/api/trpc/emails.list failed");
  });

  it("masks path segments that could be a token or an address, keeping ids and route words", () => {
    expect(scrubText(`/unsubscribe/confirm/${TOKEN}?saved=1`)).toBe("/unsubscribe/confirm/••••••");
    expect(scrubText("POST /contacts/john%40example.com")).toBe("POST /contacts/••••••");
    expect(scrubText(`https://app.example.com/emails/${ID}/settings/connected-apps`)).toBe(
      `https://app.example.com/emails/${ID}/settings/connected-apps`,
    );
    expect(scrubText("open '/app/.next/cache/page-4f2a.js'")).toBe(
      "open '/app/••••••/cache/••••••'",
    );
    expect(scrubText("/api/trpc/emails.list,settings.team.get?batch=1")).toBe(
      "/api/trpc/emails.list,settings.team.get",
    );
  });

  it("leaves fractions, dates and prose alone", () => {
    const prose = '1/2 done, 2026/10/01, and/or relation "emails" does not exist';
    expect(scrubText(prose)).toBe(prose);
  });
});

describe("scrubEvent", () => {
  const event = (): ErrorEvent => ({
    type: undefined,
    message: "send to ana@cliente.com.br failed",
    user: { id: "u1", email: "ana@cliente.com.br", ip_address: "203.0.113.9" },
    request: {
      url: `https://app.example.com/invite/${TOKEN}?next=/emails`,
      method: "POST",
      data: { html: "<p>Hello Ana</p>", to: ["ana@cliente.com.br"] },
      query_string: "input=secret",
      cookies: { "better-auth.session_token": "s" },
      env: { REMOTE_ADDR: "203.0.113.9" },
      headers: {
        Authorization: `Bearer ${KEY}`,
        "x-api-key": KEY,
        Cookie: "a=b",
        Referer: `https://app.example.com/unsubscribe/confirm/${TOKEN}`,
        "User-Agent": "Mozilla/5.0",
      },
    },
    exception: {
      values: [
        {
          type: "Error",
          value: `SES rejected bob@example.org with ${KEY}`,
          stacktrace: { frames: [{ function: "send", vars: { body: "<p>secret</p>" } }] },
        },
      ],
    },
    extra: { nested: { list: ["carol@example.net", 3] } },
    contexts: { job: { url: "https://hooks.example.com/services/T0A1/B0B2/xY9zQ?token=1" } },
    breadcrumbs: [{ category: "fetch", data: { url: "/api/trpc/x?input=1" } }],
  });

  it("drops the request body, query, cookies and every header but the user agent", () => {
    expect(scrubEvent(event()).request).toEqual({
      url: "https://app.example.com/invite/••••••",
      method: "POST",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
  });

  it("never sends a user, a local variable or an address, key or token in any text", () => {
    const scrubbed = scrubEvent(event());
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.message).toBe("send to ••••••@cliente.com.br failed");
    expect(scrubbed.exception?.values?.[0]?.value).toBe(
      "SES rejected ••••••@example.org with ••••••",
    );
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ function: "send" });
    expect(scrubbed.extra).toEqual({ nested: { list: ["••••••@example.net", 3] } });
    expect(scrubbed.contexts).toEqual({
      job: { url: "https://hooks.example.com/services/••••••/••••••/••••••" },
    });
    expect(scrubbed.breadcrumbs).toEqual([{ category: "fetch", data: { url: "/api/trpc/x" } }]);
    expect(JSON.stringify(scrubbed)).not.toMatch(/ana@|bob@|carol@|ms_|secret|Bearer|eyJ/);
  });
});

describe("scrubBreadcrumb and scrubSpan", () => {
  it("cut navigation URLs and click messages", () => {
    expect(
      scrubBreadcrumb({
        category: "ui.click",
        message: 'button[title="dave@example.com"]',
        data: { from: `/invite/${TOKEN}`, to: "/emails?status=sent" },
      }),
    ).toEqual({
      category: "ui.click",
      message: 'button[title="••••••@example.com"]',
      data: { from: "/invite/••••••", to: "/emails" },
    });
  });

  it("cut a span's name and attributes", () => {
    const span = {
      name: `GET /unsubscribe/confirm/${TOKEN}`,
      attributes: { "url.full": `https://app.example.com/t/c/${TOKEN}?u=1`, "http.status": 200 },
    } as unknown as StreamedSpanJSON;
    expect(scrubSpan(span)).toMatchObject({
      name: "GET /unsubscribe/confirm/••••••",
      attributes: { "url.full": "https://app.example.com/t/c/••••••", "http.status": 200 },
    });
  });
});

describe("errorTrackingOptions", () => {
  const config = { dsn: "https://k@errors.example.com/1", environment: "production" };

  it("sends errors only, scrubbed, and no sessions, replay or profiling", () => {
    const options = errorTrackingOptions({ ...config, release: "c8ce832", tracesSampleRate: 0 });
    expect(options).toMatchObject({
      dsn: config.dsn,
      release: "c8ce832",
      defaultIntegrations: false,
      sendClientReports: false,
      tracePropagationTargets: [],
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    });
    expect("tracesSampleRate" in options).toBe(false);
    expect(Object.values(options.dataCollection).flat()).not.toContain(true);
  });

  it("traces, scrubbed too, only once a rate is set", () => {
    expect(
      errorTrackingOptions({ ...config, release: undefined, tracesSampleRate: 0.2 }),
    ).toMatchObject({ tracesSampleRate: 0.2, beforeSendSpan: scrubSpan });
  });
});
