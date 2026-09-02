import { parseArgs } from "node:util";
import { CLOUD_API_URL, TRADEMARK_NOTICE, VERSION } from "./meta.js";
import { PROVIDERS, type ProviderId, RESOURCES, type Resource } from "./model.js";
import { providers } from "./providers/index.js";

export type Command = "migrate" | "plan" | "apply" | "status" | "rollback" | "help" | "version";

export type KeySource = "env" | "flag" | "stdin" | "prompt";

/** Where a key comes from; `value` is set for env/flag, read later for stdin/prompt. */
export interface KeyInput {
  source: KeySource;
  value: string | null;
}

/** Mirrors the API's `on_conflict` for POST /contacts/batch. */
export type OnConflict = "upsert" | "skip" | "error";

export interface Config {
  command: Command;
  /** `migrate apply <file>` */
  planFile: string | null;
  from: ProviderId | null;
  fromKey: KeyInput;
  toKey: KeyInput;
  /** Trailing slash stripped; null means ask (Cloud or self-hosted URL). */
  toUrl: string | null;
  rps: number;
  only: Resource[] | null;
  skip: Resource[];
  onConflict: OnConflict;
  yes: boolean;
  nonInteractive: boolean;
  json: boolean;
  out: string | null;
  report: string | null;
  color: boolean;
  verbose: boolean;
  freshWebhookSecrets: boolean;
  includeSent: boolean;
  fresh: boolean;
  /** Printed to stderr before anything runs (e.g. a key passed on the command line). */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_RPS = 8;
export const MAX_RPS = 10;

export const TARGET_KEY_ENV = "MILLIONSEND_API_KEY";
export const TARGET_URL_ENV = "MILLIONSEND_BASE_URL";

/** RESEND_API_KEY for `resend`. */
export const sourceKeyEnv = (provider: ProviderId): string => `${provider.toUpperCase()}_API_KEY`;

const OPTIONS = {
  from: { type: "string" },
  "from-key": { type: "string" },
  "from-key-stdin": { type: "boolean" },
  "to-url": { type: "string" },
  "to-key": { type: "string" },
  "to-key-stdin": { type: "boolean" },
  rps: { type: "string" },
  only: { type: "string" },
  skip: { type: "string" },
  "on-conflict": { type: "string" },
  yes: { type: "boolean", short: "y" },
  "non-interactive": { type: "boolean" },
  json: { type: "boolean" },
  out: { type: "string" },
  report: { type: "string" },
  "no-color": { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
  "fresh-webhook-secrets": { type: "boolean" },
  "include-sent": { type: "boolean" },
  fresh: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

const SUBCOMMANDS = ["plan", "apply", "status", "rollback"] as const;
const GRAMMAR =
  "millionsend migrate --from resend | migrate plan | migrate apply [plan.json] | migrate status | migrate rollback";

function resourceList(flag: string, value: string | undefined): Resource[] | null {
  if (value === undefined) return null;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of names) {
    if (!(RESOURCES as readonly string[]).includes(name)) {
      throw new ConfigError(
        `Unknown resource \`${name}\` in ${flag}. Known: ${RESOURCES.join(", ")}`,
      );
    }
  }
  return names as Resource[];
}

function keyInput(
  envName: string,
  env: NodeJS.ProcessEnv,
  stdinFlag: boolean,
  flagValue: string | undefined,
  flagName: string,
  warnings: string[],
): KeyInput {
  if (stdinFlag && flagValue !== undefined) {
    throw new ConfigError(`Pass either ${flagName} or ${flagName}-stdin, not both.`);
  }
  const fromEnv = env[envName];
  if (fromEnv !== undefined && fromEnv !== "") return { source: "env", value: fromEnv };
  if (stdinFlag) return { source: "stdin", value: null };
  if (flagValue !== undefined) {
    warnings.push(
      `${flagName} is visible to other users in process lists; prefer ${envName} or ${flagName}-stdin.`,
    );
    return { source: "flag", value: flagValue };
  }
  return { source: "prompt", value: null };
}

function apiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`Not a URL: ${value}. Expected e.g. ${CLOUD_API_URL}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`The MillionSend API URL must be http(s): ${value}`);
  }
  return value.replace(/\/+$/, "");
}

/**
 * Flags + environment → Config, or a ConfigError naming exactly what to set.
 * Pure: reads nothing but its arguments, so the same argv is decidable in tests.
 */
export function parseConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTTY: boolean = process.stdin.isTTY === true,
): Config {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    const reason = (error as Error).message.split(". ")[0] ?? "Bad arguments";
    throw new ConfigError(`${reason}. See millionsend --help`);
  }

  if (values.version === true) return minimal("version");
  if (values.help === true || positionals.length === 0) return minimal("help");

  const [top, sub, file, ...rest] = positionals;
  if (top !== "migrate") {
    throw new ConfigError(`Unknown command \`${top}\`. Usage: ${GRAMMAR}`);
  }
  if (sub !== undefined && !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new ConfigError(`Unknown command \`migrate ${sub}\`. Usage: ${GRAMMAR}`);
  }
  const command: Command = (sub as Command | undefined) ?? "migrate";
  if (file !== undefined && command !== "apply") {
    throw new ConfigError(`Unexpected argument \`${file}\`. Usage: ${GRAMMAR}`);
  }
  if (rest.length > 0) {
    throw new ConfigError(`Unexpected argument \`${rest[0]}\`. Usage: ${GRAMMAR}`);
  }
  const planFile = file ?? null;

  const warnings: string[] = [];
  const json = values.json === true;
  const nonInteractive = values["non-interactive"] === true || json || !stdinIsTTY;

  let from: ProviderId | null = null;
  if (values.from !== undefined) {
    if (!(PROVIDERS as readonly string[]).includes(values.from)) {
      throw new ConfigError(
        `Unknown provider \`${values.from}\`. Supported: ${PROVIDERS.join(", ")}`,
      );
    }
    from = values.from as ProviderId;
  }
  const needsSource = command === "migrate" || command === "plan" || command === "apply";
  if (needsSource && from === null && planFile === null) {
    throw new ConfigError(
      `Missing --from <provider>. Only \`resend\` is supported: millionsend migrate${sub === undefined ? "" : ` ${sub}`} --from resend`,
    );
  }

  const fromKey = keyInput(
    sourceKeyEnv(from ?? "resend"),
    env,
    values["from-key-stdin"] === true,
    values["from-key"],
    "--from-key",
    warnings,
  );
  const toKey = keyInput(
    TARGET_KEY_ENV,
    env,
    values["to-key-stdin"] === true,
    values["to-key"],
    "--to-key",
    warnings,
  );
  const toUrlRaw = values["to-url"] ?? env[TARGET_URL_ENV];
  const toUrl = toUrlRaw === undefined || toUrlRaw === "" ? null : apiUrl(toUrlRaw);

  const needsTarget = needsSource || command === "rollback";
  if (nonInteractive && needsTarget) {
    if (needsSource && fromKey.source === "prompt") {
      throw new ConfigError(
        `Missing ${providers[from ?? "resend"].label} API key. Set ${sourceKeyEnv(from ?? "resend")} or pass --from-key-stdin (non-interactive mode never prompts).`,
      );
    }
    if (toKey.source === "prompt") {
      throw new ConfigError(
        `Missing MillionSend API key. Set ${TARGET_KEY_ENV} or pass --to-key-stdin (non-interactive mode never prompts).`,
      );
    }
    if (toUrl === null) {
      throw new ConfigError(
        `Missing MillionSend API URL. Set ${TARGET_URL_ENV} or pass --to-url <url> (${CLOUD_API_URL} for MillionSend Cloud).`,
      );
    }
    // Decided here, before any network call: the confirmation would only come after the whole source is read.
    if (command !== "plan" && values.yes !== true) {
      throw new ConfigError(
        "migrate/apply/rollback need --yes in non-interactive mode (or run `migrate plan` to only read).",
      );
    }
  }

  let rps = DEFAULT_RPS;
  if (values.rps !== undefined) {
    rps = Number(values.rps);
    if (!Number.isInteger(rps) || rps < 1 || rps > MAX_RPS) {
      throw new ConfigError(
        `--rps must be a whole number between 1 and ${MAX_RPS} (got ${values.rps}).`,
      );
    }
  }

  const onConflict = values["on-conflict"] ?? "upsert";
  if (onConflict !== "upsert" && onConflict !== "skip" && onConflict !== "error") {
    throw new ConfigError(`--on-conflict must be upsert, skip or error (got ${onConflict}).`);
  }

  if (values.out !== undefined && command !== "plan") {
    throw new ConfigError("--out only applies to `migrate plan`.");
  }

  return {
    command,
    planFile,
    from,
    fromKey,
    toKey,
    toUrl,
    rps,
    only: resourceList("--only", values.only),
    skip: resourceList("--skip", values.skip) ?? [],
    onConflict,
    yes: values.yes === true,
    nonInteractive,
    json,
    out: values.out ?? null,
    report: values.report ?? null,
    color: values["no-color"] !== true && env.NO_COLOR === undefined,
    verbose: values.verbose === true,
    freshWebhookSecrets: values["fresh-webhook-secrets"] === true,
    includeSent: values["include-sent"] === true,
    fresh: values.fresh === true,
    warnings,
  };
}

function minimal(command: "help" | "version"): Config {
  return {
    command,
    planFile: null,
    from: null,
    fromKey: { source: "prompt", value: null },
    toKey: { source: "prompt", value: null },
    toUrl: null,
    rps: DEFAULT_RPS,
    only: null,
    skip: [],
    onConflict: "upsert",
    yes: false,
    nonInteractive: true,
    json: false,
    out: null,
    report: null,
    color: true,
    verbose: false,
    freshWebhookSecrets: false,
    includeSent: false,
    fresh: false,
    warnings: [],
  };
}

export function helpText(): string {
  return `millionsend ${VERSION} — move an email account to MillionSend

Usage
  millionsend migrate --from resend                          connect, choose resources, plan, confirm, apply, summary
  millionsend migrate plan --from resend [--out plan.json]   read-only; exit 0 nothing to do, 2 changes, 1 error
  millionsend migrate apply [plan.json] [--yes]              apply a saved plan, or plan and apply in one go
  millionsend migrate status                                 what the last run created and what is left
  millionsend migrate rollback [--yes]                       delete only what this tool created
  millionsend --help | --version

Options
  --from <provider>          source provider; only \`resend\` exists
  --from-key-stdin           read the source API key from stdin (first line)
  --from-key <key>           source API key as an argument (visible in process lists; prefer the env var)
  --to-url <url>             MillionSend API URL: ${CLOUD_API_URL} for Cloud, or your instance's URL
  --to-key-stdin             read the MillionSend API key from stdin (second line when both stdin flags are set)
  --to-key <key>             MillionSend API key as an argument (same caveat)
  --rps <n>                  requests per second against the source, 1..${MAX_RPS} (default ${DEFAULT_RPS}: Resend allows 10 per team,
                             shared with your production sending)
  --only <a,b>               migrate only these resources
  --skip <a,b>               skip these resources; \`enrichment\` is the per-contact properties/topics pass
  --on-conflict <mode>       contacts that already exist on the target: upsert (default), skip, error
  --include-sent             import sent broadcasts as drafts (skipped by default)
  --fresh-webhook-secrets    mint new webhook signing secrets instead of copying them (shown once in the report)
  --fresh                    ignore resume progress; keeps what earlier runs created so rollback still works
  --out <file>               \`migrate plan\`: write the plan as JSON
  --report <file>            also write the Markdown report to this path
  -y, --yes                  skip confirmations
  --non-interactive          never prompt; a missing input is exit 1 (automatic when stdin is not a terminal, and with --json)
  --json                     JSON on stdout, progress on stderr
  -v, --verbose              log every request: GET /contacts?limit=100 → 200 (143 ms)
  --no-color                 no ANSI colors (NO_COLOR is honored too)
  -h, --help                 this text
  -V, --version              print the version

Resources
  ${RESOURCES.join(", ")}

Environment
  RESEND_API_KEY             source API key (full access; the tool only reads from Resend)
  ${TARGET_KEY_ENV}        MillionSend API key (full access)
  ${TARGET_URL_ENV}       MillionSend API URL, same as --to-url
  NO_COLOR                   disable colors
  DO_NOT_TRACK               honored, as a no-op: this tool sends no telemetry, never phones home and never checks for updates

Files (mode 0600, never a key)
  .millionsend/migrate-state.json    ids created, resume cursors, plan hash
  .millionsend/migrate-report.json   the last run's report, also as migrate-report.md

Exit codes
  0 ok · 1 error · 2 plan has changes (plan only) · 3 partial, some items failed (details in the report)

${TRADEMARK_NOTICE}
`;
}
