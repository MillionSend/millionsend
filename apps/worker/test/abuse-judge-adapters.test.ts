import { ABUSE_JUDGE_POLICY, ABUSE_JUDGE_QUESTIONS } from "@millionsend/core";
import { expect, it } from "vitest";
import { createAbuseJudge } from "../src/abuse-judge/index.js";
import { createTypesafeJudge, type FetchLike } from "../src/abuse-judge/typesafe.js";

const answers = {
  is_abuse: { type: "noul", noul: 0.88 },
  impersonation: { type: "noul", noul: 0.91 },
  category: { type: "choice", choice: "brand_impersonation" },
  language: { type: "choice", choice: "en" },
};

it("posts state and typed questions, then composes the verdict", async () => {
  let posted: { url: string; body: Record<string, unknown>; auth: string | null } | undefined;
  const judge = createTypesafeJudge({
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai",
    apiKey: "k",
    fetch: async (url, init) => {
      posted = {
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization"),
      };
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await expect(
    judge.judge("Team name: Acme\nFrom: Bank <a@x.example>", {
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({
    score: 88,
    verdict: "abuse",
    categories: ["brand_impersonation"],
    reasons: ["impersonation"],
    language: "en",
    model: "jev-1.13.0",
  });
  expect(posted).toMatchObject({
    url: "https://api.typesafe.ai/v1/systemone",
    auth: "Bearer k",
  });
  expect(posted?.body).toMatchObject({
    model: "jev-latest",
    questions: ABUSE_JUDGE_QUESTIONS,
    state: { policy: ABUSE_JUDGE_POLICY, email: "Team name: Acme\nFrom: Bank <a@x.example>" },
  });
});

const signal = () => new AbortController().signal;
const withFetch = (fetch: FetchLike) =>
  createTypesafeJudge({
    model: "jev-1.13.0",
    baseUrl: "https://api.typesafe.ai/",
    apiKey: "k",
    fetch,
  });

it("refuses without a key before calling out", async () => {
  let calls = 0;
  const judge = createTypesafeJudge({
    model: "jev-1.13.0",
    baseUrl: "https://api.typesafe.ai",
    apiKey: undefined,
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  await expect(judge.judge("x", { signal: signal() })).rejects.toMatchObject({
    class: "no_credentials",
  });
  expect(calls).toBe(0);
});

it("classes HTTP failures by status", async () => {
  const judge = (status: number) => withFetch(async () => new Response("nope", { status }));
  for (const [status, errorClass] of [
    [401, "no_credentials"],
    [403, "no_credentials"],
    [429, "throttled"],
    [529, "throttled"],
    [500, "upstream"],
  ] as const) {
    await expect(judge(status).judge("x", { signal: signal() })).rejects.toMatchObject({
      class: errorClass,
    });
  }
});

it("classes a network failure as upstream and an abort as a timeout, on the request or the body", async () => {
  const down = withFetch(async () => {
    throw new TypeError("fetch failed");
  });
  await expect(down.judge("x", { signal: signal() })).rejects.toMatchObject({ class: "upstream" });
  const slow = withFetch(
    (_url, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      ),
  );
  await expect(slow.judge("x", { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({
    class: "timeout",
  });
  const slowBody = withFetch(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      ),
  );
  await expect(slowBody.judge("x", { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({
    class: "timeout",
  });
});

it("is a parse error when a 200 is not JSON", async () => {
  const judge = withFetch(async () => new Response("<html>oops</html>", { status: 200 }));
  await expect(judge.judge("x", { signal: signal() })).rejects.toMatchObject({
    class: "parse_error",
  });
});

it("reports no model when the answer names none or an implausible one", async () => {
  for (const model of [undefined, "", "x".repeat(101), 7]) {
    const judge = withFetch(
      async () => new Response(JSON.stringify({ model, answers }), { status: 200 }),
    );
    expect((await judge.judge("x", { signal: signal() })).model).toBeUndefined();
  }
});

it("is a parse error when the body has no is_abuse noul", async () => {
  const judge = createTypesafeJudge({
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai",
    apiKey: "k",
    fetch: async () =>
      new Response(JSON.stringify({ answers: { impersonation: { type: "noul", noul: 0.9 } } }), {
        status: 200,
      }),
  });
  await expect(judge.judge("x", { signal: new AbortController().signal })).rejects.toMatchObject({
    class: "parse_error",
  });
});

it("createAbuseJudge is null when off and TypeSafe when on", () => {
  expect(createAbuseJudge(null)).toBeNull();
  expect(
    createAbuseJudge({
      provider: "typesafe",
      model: "jev-latest",
      baseUrl: "https://api.typesafe.ai",
      apiKey: "k",
      timeoutMs: 20_000,
    }),
  ).toMatchObject({ provider: "typesafe", model: "jev-latest" });
});
