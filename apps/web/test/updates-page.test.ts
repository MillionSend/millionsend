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
const { POST } = await import("@/app/api/updates/subscribe/route");

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  h.requests = [];
});
afterEach(() => vi.unstubAllEnvs());

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
});

function postForm(fields: Record<string, string>): Promise<Response> {
  return POST(
    new Request("https://app.example.com/api/updates/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  );
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
});
