import { abuseJudgeConfig, type Env } from "@millionsend/config";
import { describe, expect, it, vi } from "vitest";
import {
  createSharedNameReview,
  SHARED_NAME_POLICY,
  SHARED_NAME_QUESTIONS,
} from "../src/abuse-judge/names.js";
import type { FetchLike } from "../src/abuse-judge/typesafe.js";
import { SCREEN_JUDGE_TIMEOUT_MS } from "../src/screening.js";

const config = (fetch: FetchLike, timeoutMs = 20_000) => ({
  model: "jev-1.13.0",
  baseUrl: "https://judge.example/",
  apiKey: "k",
  timeoutMs,
  fetch,
});

const answers = (nouls: Record<string, number>) =>
  Response.json({
    model: "jev-1.13.0",
    answers: Object.fromEntries(
      Object.entries(nouls).map(([key, noul]) => [key, { type: "noul", noul }]),
    ),
  });

const username = { field: "username", value: "leo" } as const;

describe("createSharedNameReview", () => {
  it("is built from the judge's env config, and undefined while the judge is off", () => {
    const env = (vars: Record<string, string>) => ({ IS_CLOUD: false, ...vars }) as unknown as Env;
    expect(createSharedNameReview(abuseJudgeConfig(env({ ABUSE_JUDGE: "off" })))).toBeUndefined();
    expect(
      createSharedNameReview(
        abuseJudgeConfig(env({ ABUSE_JUDGE: "typesafe", ABUSE_JUDGE_API_KEY: "k" })),
      ),
    ).toBeTypeOf("function");
  });

  it("asks one typed question per name, on the pinned model, and passes names under the line", async () => {
    const posted: { url: string; auth: string | null; body: unknown }[] = [];
    const review = createSharedNameReview(
      config(async (url, init) => {
        posted.push({
          url,
          auth: new Headers(init.headers).get("authorization"),
          body: JSON.parse(String(init.body)),
        });
        return answers({ username: 0.1, from_name: 0.49 });
      }),
    );
    expect(await review?.([])).toEqual({ refused: [] });
    expect(posted).toHaveLength(0);
    expect(await review?.([username, { field: "from_name", value: "Leo \n Bot" }])).toEqual({
      refused: [],
    });
    expect(posted).toEqual([
      {
        url: "https://judge.example/v1/systemone",
        auth: "Bearer k",
        body: {
          state: { policy: SHARED_NAME_POLICY, username: "leo", from_name: "Leo Bot" },
          model: "jev-1.13.0",
          questions: {
            username: SHARED_NAME_QUESTIONS.username,
            from_name: SHARED_NAME_QUESTIONS.from_name,
          },
        },
      },
    ]);
  });

  it("refuses each name at or above the line, by its value", async () => {
    const review = createSharedNameReview(
      config(async () => answers({ username: 0.2, from_name: 0.5, label: 0.97 })),
    );
    expect(
      await review?.([
        username,
        { field: "from_name", value: "Example Bank Support" },
        { field: "label", value: "example-gov" },
      ]),
    ).toEqual({ refused: ["Example Bank Support", "example-gov"] });
  });

  it("rejects when the judge is down, answers an error, or leaves a name unanswered", async () => {
    const reviewWith = (fetch: FetchLike) => createSharedNameReview(config(fetch));
    await expect(
      reviewWith(async () => {
        throw new TypeError("fetch failed");
      })?.([username]),
    ).rejects.toMatchObject({ class: "upstream" });
    await expect(
      reviewWith(async () => new Response("nope", { status: 500 }))?.([username]),
    ).rejects.toMatchObject({ class: "upstream" });
    await expect(
      reviewWith(async () => new Response("<html></html>", { status: 200 }))?.([username]),
    ).rejects.toMatchObject({ class: "parse_error" });
    await expect(
      reviewWith(async () => answers({ from_name: 0.1 }))?.([username]),
    ).rejects.toMatchObject({ class: "parse_error" });
  });

  it("rejects as a timeout when the judge hangs, and waits no longer than a screening call", async () => {
    const hangs: FetchLike = (_url, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    await expect(createSharedNameReview(config(hangs, 20))?.([username])).rejects.toMatchObject({
      class: "timeout",
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await createSharedNameReview(config(async () => answers({ username: 0.1 })))?.([username]);
      expect(timeout).toHaveBeenCalledWith(SCREEN_JUDGE_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });
});
