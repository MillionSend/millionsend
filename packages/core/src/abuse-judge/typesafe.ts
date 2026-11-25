import { randomUUID } from "node:crypto";
import type { AbuseJudgeConfig } from "@millionsend/config";
import { abuseRules } from "../abuse-rules.js";
import { composeInboundVerdict, inboundJudgeState } from "./inbound.js";
import { composeJudgeVerdict, imageQuestions, judgeState } from "./questions.js";
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

/** How TypeSafe answers a request it will not take as sent, an image it refuses among them. */
const REJECTED = new Set([400, 413, 415, 422]);

interface ImageAsset {
  type: "image";
  format: "jpeg";
  data_base64: string;
}

/**
 * One System One call: state and typed questions in, TypeSafe's JSON out.
 * Every failure is a JudgeError. `assets` are images the state names by
 * their refs, sent with the header TypeSafe requires for them.
 */
export async function askTypesafe(
  opts: TypesafeOptions,
  ask: {
    state: Record<string, string>;
    questions: Record<string, unknown>;
    assets?: Record<string, ImageAsset> | undefined;
  },
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
        ...(ask.assets ? { "typesafe-danger-zone-images": "true" } : {}),
      },
      body: JSON.stringify({
        state: ask.state,
        model: opts.model,
        questions: ask.questions,
        ...(ask.assets ? { assets: ask.assets } : {}),
      }),
      signal,
    });
  } catch (err) {
    throwIfAbort(err);
    throw new JudgeError("upstream", "judge request failed", { cause: err });
  }
  if (!res.ok) {
    throw new JudgeError(classForStatus(res.status), `judge answered ${res.status}`, {
      status: res.status,
    });
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
  questions(): Record<string, unknown>;
  state(block: string): Record<string, string>;
  compose(answers: unknown): V;
}

const OUTBOUND: QuestionSpec<JudgeVerdict> = {
  questions: () => abuseRules().judge.outbound.questions,
  state: judgeState,
  compose: composeJudgeVerdict,
};

const INBOUND: QuestionSpec<InboundJudgeVerdict> = {
  questions: () => abuseRules().judge.inbound.questions,
  state: inboundJudgeState,
  compose: composeInboundVerdict,
};

/**
 * The outbound call with images: each a fresh ref the state's `images` names,
 * and the rules' image questions beside the outbound ones. An image TypeSafe
 * refuses fails the whole request, so a refusal is asked again as text
 * alone: the verdict is never lost to an image.
 */
async function judgeWithImages(
  opts: TypesafeOptions,
  block: string,
  images: readonly Uint8Array[],
  signal: AbortSignal,
): Promise<JudgeVerdict> {
  const refs = images.map(() => randomUUID());
  const assets = Object.fromEntries(
    images.map((jpeg, i) => [
      refs[i] as string,
      { type: "image", format: "jpeg", data_base64: Buffer.from(jpeg).toString("base64") } as const,
    ]),
  );
  let json: { answers?: unknown; model?: unknown };
  try {
    json = await askTypesafe(
      opts,
      {
        state: { ...judgeState(block), images: refs.join(" ") },
        questions: { ...OUTBOUND.questions(), ...imageQuestions() },
        assets,
      },
      signal,
    );
  } catch (err) {
    if (!(err instanceof JudgeError) || !REJECTED.has(err.status ?? 0)) throw err;
    const verdict = await ask(opts, OUTBOUND, block, signal);
    return { ...verdict, imagesRejected: true };
  }
  const verdict = composeJudgeVerdict(json.answers, { images: true });
  const model = answeredModel(json.model);
  return model ? { ...verdict, model } : verdict;
}

async function ask<V extends object>(
  opts: TypesafeOptions,
  spec: QuestionSpec<V>,
  block: string,
  signal: AbortSignal,
) {
  const json = await askTypesafe(
    opts,
    { state: spec.state(block), questions: spec.questions() },
    signal,
  );
  const verdict = spec.compose(json.answers);
  const model = answeredModel(json.model);
  return model ? { ...verdict, model } : verdict;
}

/** TypeSafe System One: typed questions in, composed verdict out. No chat, no JSON parse of prose. */
export function createTypesafeJudge(opts: TypesafeOptions): AbuseJudge {
  return {
    provider: "typesafe",
    model: opts.model,
    judge: (block, { signal, images }) =>
      images && images.length > 0
        ? judgeWithImages(opts, block, images, signal)
        : ask(opts, OUTBOUND, block, signal),
    screen: (block, { signal }) => ask(opts, INBOUND, block, signal),
  };
}
