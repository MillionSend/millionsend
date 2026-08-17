import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { SES_REGIONS, type SesRegion } from "./domain-identity.js";
import {
  createSetupClients,
  envTemplate,
  eventsPlan,
  httpsOrigin,
  runEventsSetup,
  runSetup,
  runTeardown,
  SETUP_NAMES,
  setupEnvEntries,
  setupPlan,
  teardownPlan,
  upsertEnv,
} from "./setup.js";
import {
  COMPOSE_DOWNLOAD_URL,
  composeUpArgs,
  confirmed,
  type DirState,
  detectDirState,
  envValue,
  flowPlan,
  generateSecret,
  missingSecrets,
  secretLaterHint,
  stateSummary,
} from "./setup-flow.js";
import { banner, dim, pickBannerTier, selectPrompt, wrapText } from "./tty-ui.js";

// Wrapped at print time to the live terminal width — baked-in line breaks
// double-wrap on narrow terminals (soft wrap first, then the hard break).
const DESCRIPTION_TEXT =
  "Sets up a self-hosted MillionSend end to end: a .env with generated secrets, the AWS resources (IAM user + key, SNS event topic, SES configuration set), and the Docker launch. Run it in the directory MillionSend should live in — an empty one works. Every step is offered, skippable, and safe to re-run.";
const descriptionWidth = (): number => Math.min(process.stdout.columns || 80, 80) - 2;
const DESCRIPTION = (): string => wrapText(DESCRIPTION_TEXT, descriptionWidth());

const BANNER = (): string => `millionsend · setup\n\n${DESCRIPTION()}`;

const REGION_RE = /^[a-z0-9][a-z0-9-]*$/;

const REGION_HINTS: Record<SesRegion, string> = {
  "us-east-1": "N. Virginia",
  "eu-west-1": "Ireland",
  "sa-east-1": "São Paulo",
  "ap-northeast-1": "Tokyo",
};

/** selectPrompt value for the free-form region escape hatch (TTY only). */
const OTHER_REGION = "__other__";

/**
 * readline/promises' question() drops lines that arrive while no question is
 * pending, so piping all answers at once (`printf 'a\nb\n' | cli`) loses every
 * answer after the first and the next question hangs forever. This reader
 * queues every line as it arrives; question() consumes the queue, and EOF
 * resolves pending/future questions with "" (the "accept default" answer).
 */
export function lineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const rl = createInterface({ input, output });
  const queue: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let ended = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve("");
    }
  });
  return {
    question(prompt: string): Promise<string> {
      // Hand the prompt to readline instead of writing it to output directly:
      // on a TTY, readline repaints the line on every edit (backspace, arrows)
      // using only the prompt it was given, so a prompt it never saw gets
      // erased down to nothing on the first backspace. On non-TTY output
      // rl.prompt() writes the prompt text verbatim — piped bytes unchanged.
      // After EOF readline has closed itself and prompt() would throw; the
      // direct write keeps the prompt-then-"" contract byte-identical.
      if (ended) {
        output.write(prompt);
      } else {
        rl.setPrompt(prompt);
        rl.prompt();
      }
      const line = queue.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve("");
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
}

type LineReader = ReturnType<typeof lineReader>;

export type AuthAction = "proceed" | "offer-login" | "hint-exit";

/**
 * What to do after the STS identity probe. Interactive terminals with the aws
 * CLI installed get offered a login; pipes and CLI-less machines get the
 * manual hint and exit, exactly as before the interactive flow existed.
 */
export function authAction(state: {
  identityOk: boolean;
  hasAwsCli: boolean;
  isTTY: boolean;
}): AuthAction {
  if (state.identityOk) return "proceed";
  return state.hasAwsCli && state.isTTY ? "offer-login" : "hint-exit";
}

function hasAwsCli(): boolean {
  return spawnSync("aws", ["--version"], { stdio: "ignore" }).error === undefined;
}

/** Runs a child on the operator's terminal and reports whether it exited 0. */
function runInherit(command: string, args: string[]): boolean {
  // The prompt UI holds the terminal in raw mode; hand the child a sane tty.
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  return result.error === undefined && result.status === 0;
}

function probeDocker(): string | null {
  const result = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  // "Docker Compose version v2.32.4" → "docker compose v2.32.4".
  const version = /v?\d+\.\d+[\w.-]*/.exec(result.stdout ?? "")?.[0];
  return version === undefined ? "docker compose" : `docker compose ${version}`;
}

function readCwdFile(name: string): string | null {
  const path = join(process.cwd(), name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function printHeader(): void {
  const tier = pickBannerTier(process.stdout.columns ?? 0, process.stdout.isTTY === true);
  if (tier === "plain") {
    console.log(`${BANNER()}\n`);
    return;
  }
  for (const line of banner(tier)) console.log(line);
  console.log(`\n${dim(DESCRIPTION())}\n`);
}

/**
 * End-to-end self-host wizard behind `npx @millionsend/setup`, `pnpm
 * setup:aws`, and the container's `setup` argv mode. Works from an empty
 * directory: env → secrets → AWS → launch, each step offered, state-aware,
 * and idempotent on re-runs.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const teardown = argv[0] === "teardown";
  const dryRun = argv.includes("--dry-run");
  const rl = lineReader();
  try {
    printHeader();
    if (teardown) return await teardownMain(rl, dryRun);

    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    // --dry-run spawns nothing, so the docker probe is skipped there too.
    const state = detectDirState(readCwdFile, dryRun ? null : probeDocker);
    console.log(`${dim(stateSummary(state))}\n`);

    if (dryRun) {
      const appBaseUrl =
        envValue(state.envContent, "APP_BASE_URL") ||
        process.env.APP_BASE_URL ||
        "http://localhost:3000";
      console.log("Plan:");
      const region = process.env.AWS_REGION ?? "us-east-1";
      for (const line of flowPlan(state, { appBaseUrl, region })) console.log(`  · ${line}`);
      console.log("\n--dry-run: nothing was created, written, or started.");
      return 0;
    }

    // --- env step ---
    const envPath = join(process.cwd(), ".env");
    let env = state.envContent;
    if (env === null) {
      if (await offer(rl, "No .env here — create one from the built-in template?", interactive)) {
        env = envTemplate();
        writeFileSync(envPath, env);
        console.log(dim(`Wrote ${envPath}.`));
      } else {
        console.log(dim(`Skipped. Manual: curl -o .env ${ENV_EXAMPLE_URL}`));
      }
    } else {
      console.log(dim(".env found — existing values are kept, setup only fills gaps."));
    }
    // Writes through to disk on every change so an aborted run loses nothing.
    const writeEnv = (entries: Record<string, string>): boolean => {
      if (env === null) return false;
      env = upsertEnv(env, entries);
      writeFileSync(envPath, env);
      return true;
    };

    // One APP_BASE_URL prompt feeds both the .env write and the SES events
    // route in the AWS step: https gets a push subscription, anything else
    // gets an SQS queue the worker polls.
    const defaultBase =
      envValue(env, "APP_BASE_URL") || process.env.APP_BASE_URL || "http://localhost:3000";
    const appBaseUrl =
      (
        await rl.question(
          `APP_BASE_URL — the URL the dashboard is opened at (events are pushed to https URLs; others poll an SQS queue) [${defaultBase}]: `,
        )
      ).trim() || defaultBase;
    if (env !== null && appBaseUrl !== envValue(env, "APP_BASE_URL")) {
      writeEnv({ APP_BASE_URL: appBaseUrl });
    }

    // --- secrets ---
    if (env !== null) {
      const missing = missingSecrets(env);
      if (missing.length === 0) {
        console.log(dim("Secrets already set (MASTER_ENCRYPTION_KEY, BETTER_AUTH_SECRET)."));
      }
      for (const key of missing) {
        const choice = await selectPrompt(rl, {
          label: `Generate ${key} for you?`,
          initial: interactive ? "generate" : "later",
          options: [
            { value: "generate", label: "Generate now" },
            { value: "later", label: "I'll do it later", hint: "openssl rand -base64 32" },
          ],
        });
        if (choice === "generate") {
          writeEnv({ [key]: generateSecret() });
          console.log(dim(`${key} written to .env.`));
        } else {
          console.log(secretLaterHint(key));
        }
      }
    }

    // --- aws step ---
    const hasKeys = (envValue(env, "AWS_ACCESS_KEY_ID") ?? "") !== "";
    const hasEvents = (envValue(env, "SNS_TOPIC_ARNS") ?? "") !== "";
    if (hasKeys) console.log(dim("\nAWS access key already in .env."));
    if (hasKeys && !hasEvents) {
      // The common re-run trap: sends work but events were never set up, and
      // a full re-run both mints an unwanted key and can hit the 2-key IAM
      // limit. Offer the events-only path first — it touches no IAM.
      const choice = await selectPrompt(rl, {
        label: "Event ingestion (delivered/bounce tracking) is not set up. Add it?",
        initial: interactive ? "events" : "skip",
        options: [
          {
            value: "events",
            label: "Add event ingestion",
            hint: "SNS topic + queue + configuration set; keeps the existing key",
          },
          { value: "full", label: "Full AWS re-run", hint: "also mints a NEW access key" },
          { value: "skip", label: "Skip" },
        ],
      });
      if (choice === "skip") {
        console.log(dim("AWS step skipped."));
      } else {
        await awsStep(rl, interactive, appBaseUrl, writeEnv, choice === "events");
      }
    } else {
      const awsPrompt = hasKeys
        ? "Re-run the AWS setup (mints a NEW access key)?"
        : "\nCreate the AWS resources now (IAM user + key, SNS events, SES configuration set)?";
      if (await offer(rl, awsPrompt, interactive && !hasKeys)) {
        await awsStep(rl, interactive, appBaseUrl, writeEnv);
      } else {
        console.log(dim("AWS step skipped."));
      }
    }

    // --- social login step (before launch, so the stack starts with it) ---
    await socialLoginStep(rl, appBaseUrl, writeEnv);

    return await launchStep(
      rl,
      interactive,
      state,
      env === null ? [] : missingSecrets(env),
      appBaseUrl,
    );
  } finally {
    rl.close();
  }
}

const SOCIAL_PROVIDERS = [
  {
    name: "Google",
    idKey: "GOOGLE_CLIENT_ID",
    secretKey: "GOOGLE_CLIENT_SECRET",
    consoleHint:
      "https://console.cloud.google.com/apis/credentials — OAuth client ID, type Web application",
    callbackPath: "/api/auth/callback/google",
  },
  {
    name: "GitHub",
    idKey: "GITHUB_CLIENT_ID",
    secretKey: "GITHUB_CLIENT_SECRET",
    consoleHint: "https://github.com/settings/developers — New OAuth App",
    callbackPath: "/api/auth/callback/github",
  },
] as const;

/**
 * Optional social-login step: Google/GitHub OAuth credentials for the
 * dashboard's "Continue with …" buttons. Env-only (touches no AWS resource);
 * every question defaults to skip, so piped/EOF runs sail through unchanged.
 */
async function socialLoginStep(
  rl: LineReader,
  appBaseUrl: string,
  writeEnv: (entries: Record<string, string>) => boolean,
): Promise<void> {
  console.log("");
  const wanted = await offer(
    rl,
    'Optional: social login. Google/GitHub OAuth credentials add "Continue with …" buttons to the dashboard sign-in. Configure now?',
    false,
  );
  if (!wanted) {
    console.log(dim("Skipped — set GOOGLE_/GITHUB_CLIENT_ID and _SECRET in .env any time."));
    return;
  }
  for (const provider of SOCIAL_PROVIDERS) {
    if (!(await offer(rl, `\nSet up ${provider.name} sign-in?`, false))) continue;
    console.log(dim(`Create the OAuth app: ${provider.consoleHint}`));
    console.log(dim(`Register this callback URL: ${appBaseUrl}${provider.callbackPath}`));
    const id = (await rl.question(`${provider.idKey} (empty skips): `)).trim();
    if (id === "") continue;
    const secret = (await rl.question(`${provider.secretKey}: `)).trim();
    if (secret === "") {
      console.log(dim("No secret — skipped."));
      continue;
    }
    const entries = { [provider.idKey]: id, [provider.secretKey]: secret };
    if (writeEnv(entries)) {
      console.log(dim(`${provider.name} credentials written to .env.`));
    } else {
      const block = Object.entries(entries)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      console.log(`No .env here — paste into .env where MillionSend runs:\n\n${block}\n`);
    }
  }
}

/**
 * Verifies AWS credentials, offering a login on interactive terminals with
 * the aws CLI installed. Returns the account id, or null after the manual
 * hint. STS is global; the probe region does not constrain the SES region.
 */
async function resolveIdentity(rl: LineReader): Promise<string | null> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // Two login attempts, then the manual hint — a third rarely goes better.
  for (let attempt = 0; ; attempt++) {
    // Fresh client per attempt: a login may have just minted credentials,
    // and the SDK caches its credential provider per client.
    const sts = new STSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Account) throw new Error("GetCallerIdentity returned no account");
      console.log(`${dim(`aws: ${identity.Arn ?? "?"} (account ${identity.Account})`)}\n`);
      return identity.Account;
    } catch (error) {
      console.error(`Could not verify AWS credentials: ${(error as Error).message}`);
      const action = authAction({
        identityOk: false,
        // Pipes never get the offer, so skip probing for the CLI there.
        hasAwsCli: interactive && hasAwsCli(),
        isTTY: interactive,
      });
      if (action !== "offer-login" || attempt >= 2) {
        console.error(
          "Run this where the AWS CLI/SDK finds admin credentials — `aws configure`, AWS_PROFILE, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the environment.",
        );
        return null;
      }
      const choice = await selectPrompt(rl, {
        label: "Not authenticated",
        // aws login (browser sign-in for IAM users) is the common case;
        // aws sso login only works for Identity Center profiles with
        // sso_start_url configured.
        initial: "login",
        options: [
          { value: "login", label: "Run aws login", hint: "browser sign-in" },
          { value: "sso", label: "Run aws sso login", hint: "Identity Center profiles" },
          { value: "configure", label: "Run aws configure", hint: "paste access keys" },
          { value: "exit", label: "Exit" },
        ],
      });
      if (choice === "exit") return null;
      runInherit("aws", choice === "sso" ? ["sso", "login"] : [choice]);
    }
  }
}

/** SES region prompt; null when the typed free-form region is not a region name. */
async function chooseRegion(rl: LineReader): Promise<string | null> {
  const defaultRegion = process.env.AWS_REGION ?? "us-east-1";
  let region = await selectPrompt(rl, {
    label: "AWS region",
    initial: defaultRegion,
    options: [
      ...SES_REGIONS.map((r) => ({ value: r, label: r, hint: REGION_HINTS[r] })),
      { value: OTHER_REGION, label: "Other…", hint: "type any region" },
    ],
  });
  if (region === OTHER_REGION) {
    region = (await rl.question(`AWS region [${defaultRegion}]: `)).trim() || defaultRegion;
  }
  if (!REGION_RE.test(region)) {
    console.error(`Not an AWS region name: ${region}`);
    return null;
  }
  return region;
}

/**
 * The AWS provisioning step: identity, region, plan, create, keys into .env.
 * eventsOnly skips the IAM part (no new access key) and provisions just the
 * events pipeline. Failures print their hint and return — the wizard
 * continues to the launch step, since a stack can boot (not send) without
 * AWS keys.
 */
async function awsStep(
  rl: LineReader,
  interactive: boolean,
  appBaseUrl: string,
  writeEnv: (entries: Record<string, string>) => boolean,
  eventsOnly = false,
): Promise<void> {
  const accountId = await resolveIdentity(rl);
  if (accountId === null) return;
  const region = await chooseRegion(rl);
  if (region === null) return;

  console.log("\nPlan:");
  const plan = eventsOnly ? eventsPlan : setupPlan;
  for (const line of plan({ region, appBaseUrl })) console.log(`  · ${line}`);
  if (!(await offer(rl, "\nProceed?", interactive))) return;

  const input = {
    region,
    accountId,
    appBaseUrl,
    onStep: (line: string) => console.log(`==> ${line}`),
  };
  let entries: Record<string, string>;
  try {
    if (eventsOnly) {
      const events = await runEventsSetup(createSetupClients(region), input);
      entries = {
        SNS_TOPIC_ARNS: events.topicArn,
        SES_CONFIGURATION_SET: SETUP_NAMES.configurationSet,
        ...(events.queueUrl ? { SQS_QUEUE_URL: events.queueUrl } : {}),
      };
    } else {
      entries = setupEnvEntries(region, await runSetup(createSetupClients(region), input));
    }
  } catch (error) {
    console.error(
      `AWS setup failed: ${(error as Error).message}\nFix that and re-run — resources it already created are adopted, not duplicated.`,
    );
    return;
  }

  if (writeEnv(entries)) {
    console.log(`\n${eventsOnly ? "Event ingestion values" : "AWS keys"} written to .env.`);
  } else {
    const block = Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    console.log(`\nDone. Paste into .env where MillionSend runs, then restart it:\n\n${block}\n`);
  }
  if (httpsOrigin(appBaseUrl)) {
    console.log(
      "The SNS subscription confirms itself once the app runs with these values;\nif it stays pending, use 'Request confirmation' on it in the SNS console.",
    );
  }
}

const ENV_EXAMPLE_URL =
  "https://raw.githubusercontent.com/MillionSend/millionsend/main/.env.example";

/** The launch step: optional compose download, then docker compose up. */
async function launchStep(
  rl: LineReader,
  interactive: boolean,
  state: DirState,
  secretsMissing: string[],
  appBaseUrl: string,
): Promise<number> {
  console.log("");
  if (state.docker === null) {
    console.log(
      "docker not found — install it (https://docs.docker.com/get-docker/), then run: docker compose up -d",
    );
    return 0;
  }
  const choice = await selectPrompt(rl, {
    label: "Start MillionSend now?",
    initial: interactive ? "start" : "later",
    options: [
      { value: "start", label: "Start", hint: "docker compose up" },
      { value: "later", label: "Later" },
    ],
  });

  let composeContent = state.composeContent;
  if (choice === "start" && composeContent === null) {
    if (
      await offer(
        rl,
        "No compose file here — download the standalone deploy/docker-compose.yml?",
        interactive,
      )
    ) {
      try {
        const response = await fetch(COMPOSE_DOWNLOAD_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        composeContent = await response.text();
        writeFileSync(join(process.cwd(), "docker-compose.yml"), composeContent);
        console.log(dim("Wrote docker-compose.yml."));
      } catch (error) {
        console.error(`Download failed (${(error as Error).message}).`);
      }
    }
  }

  const command = `docker ${composeUpArgs(composeContent).join(" ")}`;
  if (choice !== "start" || composeContent === null) {
    const curlLine =
      composeContent === null && state.composeFile === null
        ? `\n  curl -O ${COMPOSE_DOWNLOAD_URL}`
        : "";
    console.log(`Start later with:${curlLine}\n  ${command}`);
    return 0;
  }

  if (secretsMissing.length > 0) {
    console.log(`note: ${secretsMissing.join(", ")} still empty in .env — the app needs them.`);
  }
  console.log(`\n$ ${command}`);
  if (!runInherit("docker", composeUpArgs(composeContent))) {
    console.error("docker compose failed — fix the error above and re-run the setup.");
    return 1;
  }
  console.log(
    `\nRunning. Next steps:\n  · ${appBaseUrl} — sign up (the first user becomes the owner)\n  · SES sandbox account? Set the send rate to 1 in Settings → Instance\n  · Verify a sending domain in the dashboard, then send`,
  );
  return 0;
}

/** The pre-wizard teardown flow, unchanged: identity, region, delete. */
async function teardownMain(rl: LineReader, dryRun: boolean): Promise<number> {
  let accountId = "";
  if (dryRun) {
    console.log("--dry-run: skipping the AWS credential check.\n");
  } else {
    const resolved = await resolveIdentity(rl);
    if (resolved === null) return 1;
    accountId = resolved;
  }
  const region = await chooseRegion(rl);
  if (region === null) return 1;
  return await teardownFlow(rl, region, accountId, dryRun);
}

async function teardownFlow(
  rl: LineReader,
  region: string,
  accountId: string,
  dryRun: boolean,
): Promise<number> {
  console.log("\nTeardown deletes:");
  for (const line of teardownPlan(region)) console.log(`  · ${line}`);
  if (dryRun) {
    console.log("\n--dry-run: nothing was deleted.");
    return 0;
  }
  if (!(await confirm(rl, "\nDelete these? The access keys stop working immediately."))) return 1;
  await runTeardown(createSetupClients(region), {
    region,
    accountId,
    onStep: (line) => console.log(`==> deleting ${line}`),
  });
  console.log("\nDone. Remove the AWS_* / SNS_TOPIC_ARNS / SES_CONFIGURATION_SET lines from .env.");
  return 0;
}

async function confirm(rl: LineReader, prompt: string): Promise<boolean> {
  return confirmed(await rl.question(`${prompt} [y/N] `), false);
}

/**
 * A wizard offer: defaults to yes on interactive terminals (Enter accepts),
 * to no otherwise — piped/EOF runs skip every offer deterministically.
 */
async function offer(rl: LineReader, prompt: string, defaultYes: boolean): Promise<boolean> {
  return confirmed(await rl.question(`${prompt} ${defaultYes ? "[Y/n]" : "[y/N]"} `), defaultYes);
}
