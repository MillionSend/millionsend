import { type KeyInput, sourceKeyEnv, TARGET_KEY_ENV, TARGET_URL_ENV } from "./config.js";
import type { Context } from "./context.js";
import { AuthError, createHttp } from "./http.js";
import { CLOUD_API_URL, USER_AGENT, VERSION } from "./meta.js";
import { createMillionSendTarget, type MillionSendTarget } from "./millionsend.js";
import { type ProviderId, RESOURCES, type Resource, type TargetUsage } from "./model.js";
import type { Progress, StepHandle } from "./progress.js";
import { type OnProgress, type Provider, providers, type Source } from "./providers/index.js";
import { RESEND_BASE_URL_ENV } from "./providers/resend.js";
import { dim, ok, SYM, wrapIndent } from "./theme.js";
import { banner, pickBannerTier, secretPrompt, selectPrompt, textPrompt } from "./tty-ui.js";
import { capitalize, formatNumber } from "./utils.js";

/** MillionSend allows 600 requests per minute per key; batch endpoints keep the real rate far below. */
export const TARGET_RPS = 10;

export interface SourceSession {
  provider: Provider;
  source: Source;
}

export interface TargetSession {
  target: MillionSendTarget;
  usage: TargetUsage;
  baseUrl: string;
}

/** Banner (tier by columns) and the two-line description; plain one-liner on pipes. */
export function printHeader(ctx: Context, text: string): void {
  const { out } = ctx;
  const tier = pickBannerTier(out.columns ?? 0, out.isTTY === true);
  if (tier === "plain") {
    out.write(`${wrapIndent(`millionsend ${VERSION} — ${text}`, { hanging: "  " })}\n\n`);
    return;
  }
  for (const line of banner(tier)) out.write(`${line}\n`);
  out.write(`\n${dim(wrapIndent(text))}\n\n`);
}

async function resolveKey(
  ctx: Context,
  input: KeyInput,
  { label, envName, flag }: { label: string; envName: string; flag: string },
): Promise<string> {
  if (input.value !== null) return input.value;
  if (input.source === "stdin") {
    const line = (await ctx.rl.question("")).trim();
    if (line === "") throw new Error(`No ${label} arrived on stdin (${flag}-stdin).`);
    return line;
  }
  if (ctx.config.nonInteractive) {
    throw new Error(`Missing ${label}. Set ${envName} or pass ${flag}-stdin.`);
  }
  const key = await secretPrompt(ctx.rl, { label: `${label} (full access)` });
  if (key === "") throw new Error(`Missing ${label}. Set ${envName} or pass ${flag}-stdin.`);
  return key;
}

export async function connectSource(ctx: Context, id: ProviderId): Promise<SourceSession> {
  const provider = providers[id];
  const envName = sourceKeyEnv(id);
  const baseUrl = provider.baseUrl(ctx.env);
  if (ctx.config.toUrl !== null && new URL(baseUrl).host === new URL(ctx.config.toUrl).host) {
    throw new Error(
      `${provider.label} API URL ${baseUrl} is the MillionSend host; the ${provider.label} key would be sent there. Unset ${RESEND_BASE_URL_ENV}, or point ${TARGET_URL_ENV} / --to-url at your MillionSend instance.`,
    );
  }
  const token = await resolveKey(ctx, ctx.config.fromKey, {
    label: `${provider.label} API key`,
    envName,
    flag: "--from-key",
  });
  const http = createHttp({
    baseUrl,
    token,
    userAgent: USER_AGENT,
    rps: ctx.config.rps,
    log: ctx.log,
    name: provider.label,
    readOnly: true,
    fetch: ctx.fetch,
  });
  const source = provider.create(http, ctx.log);
  try {
    await source.probe();
  } catch (error) {
    if (error instanceof AuthError) {
      throw new Error(
        `${provider.label} rejected the API key (${error.status}). Check ${envName}: it must be a full-access key of the account to migrate.`,
      );
    }
    throw error;
  }
  const host = baseUrl === provider.baseUrl({}) ? "" : ` (${baseUrl})`;
  ctx.out.write(`${ok(SYM.ok)} ${provider.label} ${dim("·")} connected${host}\n`);
  return { provider, source };
}

async function resolveTargetUrl(ctx: Context): Promise<string> {
  if (ctx.config.toUrl !== null) return ctx.config.toUrl;
  const choice = await selectPrompt(ctx.rl, {
    label: "Where is MillionSend running?",
    options: [
      { value: "cloud", label: `MillionSend Cloud (${new URL(CLOUD_API_URL).host})` },
      { value: "self", label: "Self-hosted instance (enter its API URL)" },
    ],
  });
  if (choice === "cloud") return CLOUD_API_URL;
  const url = await textPrompt(ctx.rl, {
    label: "MillionSend API URL",
    validate: (value) =>
      /^https?:\/\/\S+$/.test(value)
        ? undefined
        : "must be a URL starting with http:// or https://",
  });
  return url.replace(/\/+$/, "");
}

export async function connectTarget(ctx: Context): Promise<TargetSession> {
  const baseUrl = await resolveTargetUrl(ctx);
  const token = await resolveKey(ctx, ctx.config.toKey, {
    label: "MillionSend API key",
    envName: TARGET_KEY_ENV,
    flag: "--to-key",
  });
  const http = createHttp({
    baseUrl,
    token,
    userAgent: USER_AGENT,
    rps: TARGET_RPS,
    log: ctx.log,
    name: "MillionSend",
    fetch: ctx.fetch,
  });
  const target = createMillionSendTarget(http, ctx.log, baseUrl);
  const usage = await target.probe();
  ctx.out.write(
    usage.cloud
      ? `${ok(SYM.ok)} MillionSend Cloud ${dim("·")} plan ${capitalize(usage.plan ?? "unknown")}\n`
      : `${ok(SYM.ok)} MillionSend ${dim("·")} ${baseUrl} (self-hosted)\n`,
  );
  return { target, usage, baseUrl };
}

/** Source read events → one progress step per label, closed on `done`. */
export function bridgeProgress(progress: Progress): OnProgress {
  let current: { label: string; step: StepHandle } | null = null;
  return (event) => {
    if (current === null || current.label !== event.label) {
      current = { label: event.label, step: progress.step(event.label) };
    }
    current.step.update(event.n, event.total);
    if (event.done) {
      current.step.done(formatNumber(event.n));
      current = null;
    }
  };
}

/** --only / --skip → the resources to read and plan. */
export function includeSet(config: Context["config"]): Set<Resource> {
  const set = new Set<Resource>(config.only ?? RESOURCES);
  for (const resource of config.skip) set.delete(resource);
  return set;
}
