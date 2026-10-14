import type { AbuseJudgeConfig } from "@millionsend/config";
import { composeInboundVerdict, INBOUND_JUDGE_QUESTIONS, inboundJudgeState } from "./inbound.js";
import { ABUSE_JUDGE_QUESTIONS, composeJudgeVerdict, judgeState } from "./questions.js";
import {
  type AbuseJudge,
  type InboundJudgeVerdict,
  JudgeError,
  type JudgeVerdict,
} from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type TypesafeOptions = Pick<AbuseJudgeConfig, "model" | "baseUrl" | "apiKey"> & {
  fetch?: FetchLike;
};

const MODEL_ID_MAX = 100;

function throwIfAbort(err: unknown): void {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    throw new JudgeError("timeout", "judge call timed out", { cause: err });
  }
}

/** The versioned id TypeSafe reports as having answered, when it looks like one. */
function answeredModel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MODEL_ID_MAX
    ? value
    : undefined;
}

function classForStatus(status: number): "throttled" | "no_credentials" | "upstream" {
  if (status === 429 || status === 529) return "throttled";
  if (status === 401 || status === 403) return "no_credentials";
  return "upstream";
}

/** One System One call: state and typed questions in, TypeSafe's JSON out. Every failure is a JudgeError. */
export async function askTypesafe(
  opts: TypesafeOptions,
  ask: { state: Record<string, string>; questions: Record<string, unknown> },
  signal: AbortSignal,
): Promise<{ answers?: unknown; model?: unknown }> {
  if (!opts.apiKey) throw new JudgeError("no_credentials", "ABUSE_JUDGE_API_KEY is unset");
  const fetcher: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await fetcher(`${opts.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ state: ask.state, model: opts.model, questions: ask.questions }),
      signal,
    });
  } catch (err) {
    throwIfAbort(err);
    throw new JudgeError("upstream", "judge request failed", { cause: err });
  }
  if (!res.ok) {
    throw new JudgeError(classForStatus(res.status), `judge answered ${res.status}`);
  }
  try {
    return (await res.json()) as { answers?: unknown; model?: unknown };
  } catch (err) {
    // The timeout signal also covers reading the body.
    throwIfAbort(err);
    throw new JudgeError("parse_error", "judge body was not JSON", { cause: err });
  }
}

/** One question set: the questions posted, the state built from the block, the answers composed. */
interface QuestionSpec<V> {
  questions: Record<string, unknown>;
  state(block: string): Record<string, string>;
  compose(answers: unknown): V;
}

const OUTBOUND: QuestionSpec<JudgeVerdict> = {
  questions: ABUSE_JUDGE_QUESTIONS,
  state: judgeState,
  compose: composeJudgeVerdict,
};

const INBOUND: QuestionSpec<InboundJudgeVerdict> = {
  questions: INBOUND_JUDGE_QUESTIONS,
  state: inboundJudgeState,
  compose: composeInboundVerdict,
};

/** TypeSafe System One: typed questions in, composed verdict out. No chat, no JSON parse of prose. */
export function createTypesafeJudge(opts: TypesafeOptions): AbuseJudge {
  async function ask<V extends object>(spec: QuestionSpec<V>, block: string, signal: AbortSignal) {
    const json = await askTypesafe(
      opts,
      { state: spec.state(block), questions: spec.questions },
      signal,
    );
    const verdict = spec.compose(json.answers);
    const model = answeredModel(json.model);
    return model ? { ...verdict, model } : verdict;
  }
  return {
    provider: "typesafe",
    model: opts.model,
    judge: (block, { signal }) => ask(OUTBOUND, block, signal),
    screen: (block, { signal }) => ask(INBOUND, block, signal),
  };
}
