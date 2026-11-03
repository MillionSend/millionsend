import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requests: [] as { email: string; source: string; locale: string }[],
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => ({}) };
});
vi.mock("@/server/updates", () => ({
  requestUpdatesConfirmation: async (
    _db: unknown,
    input: { email: string; source: string; locale: string },
  ) => {
    h.requests.push(input);
    return true;
  },
}));

const { default: UpdatesPage } = await import("@/app/updates/page");
const route = await import("@/app/api/updates/subscribe/route");
const { POST } = route;

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  h.requests = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The form's own markup; the screen chrome around it needs the app's providers. */
async function formMarkup(query: Record<string, string>): Promise<string> {
  const page = await UpdatesPage({ searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(page.props.children);
}

describe("updates page", () => {
  it("forwards a known ?source= in its form and falls back to updates otherwise", async () => {
    expect(await formMarkup({ source: "self-host" })).toContain(
      '<input type="hidden" name="source" value="self-host"/>',
    );
    expect(await formMarkup({})).toContain('<input type="hidden" name="source" value="updates"/>');
    expect(await formMarkup({ source: "signup" })).toContain(
      '<input type="hidden" name="source" value="updates"/>',
    );
  });

  it("carries the Turnstile widget only where the instance has a site key, and says when it failed", async () => {
    expect(await formMarkup({})).not.toContain("cf-turnstile");
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA");
    expect(await formMarkup({})).toContain(
      '<div class="cf-turnstile" data-sitekey="0x4AAA" data-appearance="interaction-only"></div>',
    );
    expect(await formMarkup({ error: "captcha" })).toContain("Verification failed. Try again.");
  });
});

/** A post from `ip`, which the self-host walk reads as the client: the limiters live as long as the module. */
function request(body: string, contentType: string, ip?: string): Request {
  return new Request("https://app.example.com/api/updates/subscribe", {
    method: "POST",
    headers: { "content-type": contentType, ...(ip ? { "x-forwarded-for": ip } : {}) },
    body,
  });
}

function postForm(fields: Record<string, string>, ip?: string, post = POST): Promise<Response> {
  return post(
    request(new URLSearchParams(fields).toString(), "application/x-www-form-urlencoded", ip),
  );
}

function postJson(body: unknown, ip?: string): Promise<Response> {
  return POST(request(JSON.stringify(body), "application/json", ip));
}

describe("subscribe route", () => {
  it("tags the request with the form's source and sends the reader back with it", async () => {
    const res = await postForm({ email: "op@example.com", source: "self-host" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://app.example.com/updates?sent=1&source=self-host",
    );
    expect(h.requests).toEqual([{ email: "op@example.com", source: "self-host", locale: "en" }]);
  });

  it("defaults to the page's own source and never echoes it", async () => {
    const res = await postForm({ email: "reader@example.com" });
    expect(res.headers.get("location")).toBe("https://app.example.com/updates?sent=1");
    expect(h.requests.map((r) => r.source)).toEqual(["updates"]);
  });

  it("refuses an unknown source", async () => {
    const res = await postForm({ email: "x@example.com", source: "signup" });
    expect(res.headers.get("location")).toBe("https://app.example.com/updates?error=invalid");
    expect(h.requests).toEqual([]);
  });

  it("keeps a known source on the way back from an invalid address", async () => {
    const res = await postForm({ email: "not-an-address", source: "self-host" });
    expect(res.headers.get("location")).toBe(
      "https://app.example.com/updates?error=invalid&source=self-host",
    );
    expect(h.requests).toEqual([]);
  });

  it("takes a post without a token where the instance has no Turnstile keys, and answers no other origin", async () => {
    const res = await postJson({ email: "json@example.com" }, "203.0.113.20");
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(h.requests.map((r) => r.email)).toEqual(["json@example.com"]);
    expect(route).not.toHaveProperty("OPTIONS");
  });

  it("caps the instance at 20 requests an hour, whoever sends them", async () => {
    vi.resetModules();
    const fresh = await import("@/app/api/updates/subscribe/route");
    for (let i = 1; i <= 20; i++) {
      const res = await postForm({ email: `r${i}@example.com` }, `198.51.100.${i}`, fresh.POST);
      expect(res.headers.get("location")).toBe("https://app.example.com/updates?sent=1");
    }
    const over = await postForm({ email: "r21@example.com" }, "198.51.100.21", fresh.POST);
    expect(over.headers.get("location")).toBe("https://app.example.com/updates?error=rate");
    expect(h.requests).toHaveLength(20);
  });

  it("answers a JSON post past the client's hourly cap with 429 and retry-after", async () => {
    vi.resetModules();
    const fresh = await import("@/app/api/updates/subscribe/route");
    const post = () =>
      fresh.POST(
        request(JSON.stringify({ email: "j@example.com" }), "application/json", "203.0.113.30"),
      );
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(202);
    const over = await post();
    expect(over.status).toBe(429);
    const wait = Number(over.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(3600);
  });
});

describe("subscribe route with Turnstile keys", () => {
  beforeEach(() => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4BBB");
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const { response } = JSON.parse(String(init?.body)) as { response: string };
      return Response.json({ success: response === "good-token" });
    });
  });

  it("sends a form without a passing token back to the page, and refuses JSON with 403", async () => {
    const missing = await postForm({ email: "a@example.com", source: "self-host" }, "203.0.113.1");
    expect(missing.headers.get("location")).toBe(
      "https://app.example.com/updates?error=captcha&source=self-host",
    );
    const rejected = await postForm(
      { email: "a@example.com", "cf-turnstile-response": "bad-token" },
      "203.0.113.1",
    );
    expect(rejected.headers.get("location")).toBe("https://app.example.com/updates?error=captcha");
    const json = await postJson({ email: "a@example.com" }, "203.0.113.2");
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({ error: "captcha" });
    expect(h.requests).toEqual([]);
  });

  it("subscribes with the widget's token, and a refused post never spends the instance's hour", async () => {
    vi.resetModules();
    const fresh = await import("@/app/api/updates/subscribe/route");
    for (let i = 1; i <= 25; i++) {
      const res = await postForm({ email: "bot@example.com" }, `192.0.2.${i}`, fresh.POST);
      expect(res.headers.get("location")).toBe("https://app.example.com/updates?error=captcha");
    }
    const res = await postForm(
      { email: "a@example.com", "cf-turnstile-response": "good-token" },
      "203.0.113.3",
      fresh.POST,
    );
    expect(res.headers.get("location")).toBe("https://app.example.com/updates?sent=1");
    expect(h.requests.map((r) => r.email)).toEqual(["a@example.com"]);
  });
});
