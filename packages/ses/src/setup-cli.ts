import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
// Relative import, not a workspace dependency: this file is bundled into
// @millionsend/setup and run under tsx from the repo root, and neither path
// resolves package names. The prompt kit lives in the MIT package so the
// AGPL wizard consumes it, never the reverse.
import { createFlow, type Flow } from "../../cli/src/flow.js";
import { banner, isInteractive, lineReader, pickBannerTier } from "../../cli/src/tty-ui.js";
import { SES_REGIONS, type SesRegion } from "./domain-identity.js";
import {
  addRegionPlan,
  cancelPricingPlan,
  createSetupClients,
  createStorageClient,
  ESSENTIALS_WARNING,
  ensureBucket,
  envTemplate,
  eventsPlan,
  httpsOrigin,
  parseSqsQueueUrl,
  readPricingPlan,
  runEventsSetup,
  runSetup,
  runTeardown,
  SETUP_NAMES,
  type SetupSesClient,
  STORAGE_BUCKET_DEFAULTS,
  setupEnvEntries,
  setupPlan,
  setupPolicyArn,
  storageEnvEntries,
  syncAdoptedPolicy,
  teardownPlan,
  upsertEnv,
} from "./setup.js";
import {
  addRegionEnvEntries,
  CLOUD_REQUIRED_KEYS,
  COMPOSE_DOWNLOAD_URL,
  composeUpArgs,
  type DirState,
  detectDirState,
  envValue,
  flowPlan,
  freshDatabaseEntries,
  fullRerunOffered,
  generateSecret,
  isCloudEnv,
  menuOptions,
  missingSecrets,
  secretLaterHint,
  servedRegionsInEnv,
  sesEventsProxyHint,
  setupDone,
  stateSummary,
  withComposeProfile,
} from "./setup-flow.js";

const DESCRIPTION_TEXT =
  "Sets up a self-hosted MillionSend end to end: a .env with generated secrets, the AWS resources (IAM user + key, SNS event topic, SES configuration set), and the Docker launch. Run it in the directory MillionSend should live in — an empty one works. Every step is offered, skippable, and safe to re-run. Sub-commands: add-region <region> (a further SES region on an existing install), teardown.";

const REGION_RE = /^[a-z0-9][a-z0-9-]*$/;

const REGION_HINTS: Record<SesRegion, string> = {
  "us-east-1": "N. Virginia",
  "eu-west-1": "Ireland",
  "sa-east-1": "São Paulo",
  "ap-northeast-1": "Tokyo",
};

/** selectPrompt value for the free-form region escape hatch (TTY only). */
const OTHER_REGION = "__other__";

const DEFAULT_APP_BASE_URL = "http://localhost:3000";

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

/** The banner art on a wide terminal; pipes and narrow terminals get nothing here. */
function printBanner(): void {
  const tier = pickBannerTier(process.stdout.columns ?? 0, process.stdout.isTTY === true);
  if (tier === "plain") return;
  for (const line of banner(tier)) console.log(line);
  console.log("");
}

/**
 * What every step works on: the flow it prints through, the .env it reads
 * and writes (written through to disk on every change so an aborted run
 * loses nothing, owner-only so a pre-existing world-readable file is
 * tightened too), and the answers the steps share.
 */
interface Wizard {
  flow: Flow;
  interactive: boolean;
  cloud: boolean;
  state: DirState;
  env: string | null;
  writeEnv(entries: Record<string, string>): boolean;
  enableProfile(profile: string): boolean;
  /** The dashboard origin: .env, then the process env, then the compose default. */
  appBaseUrl(): string;
  /** The api's own listen port, for the reverse-proxy hint the AWS step prints. */
  apiPort(): number;
}

function createWizard(
  flow: Flow,
  state: DirState,
  cloud: boolean,
  env: string | null,
  envPath: string | null,
): Wizard {
  const save = (): void => {
    if (envPath === null || wizard.env === null) return;
    writeFileSync(envPath, wizard.env, { mode: 0o600 });
    chmodSync(envPath, 0o600);
  };
  const wizard: Wizard = {
    flow,
    interactive: isInteractive(),
    cloud,
    state,
    env,
    writeEnv(entries) {
      if (wizard.env === null || envPath === null) return false;
      wizard.env = upsertEnv(wizard.env, entries);
      save();
      return true;
    },
    enableProfile(profile) {
      if (wizard.env === null || envPath === null) return false;
      wizard.env = withComposeProfile(wizard.env, profile);
      save();
      return true;
    },
    appBaseUrl: () =>
      envValue(wizard.env, "APP_BASE_URL") || process.env.APP_BASE_URL || DEFAULT_APP_BASE_URL,
    apiPort: () => Number(envValue(wizard.env, "PORT")) || 3001,
  };
  return wizard;
}

/** `KEY=value` lines for an operator to paste when there is no .env to write. */
const pasteBlock = (entries: Record<string, string>): string =>
  Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

/**
 * End-to-end self-host wizard behind `npx @millionsend/setup`, `pnpm
 * setup:aws`, and the container's `setup` argv mode. Works from an empty
 * directory: env → secrets → AWS → object storage → social login → launch,
 * each step offered, state-aware, and idempotent on re-runs. An install that
 * is already set up opens on a menu of things to do instead.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const rl = lineReader();
  const flow = createFlow(rl);
  try {
    printBanner();
    if (argv[0] === "add-region") return await addRegionMain(flow, argv.slice(1), dryRun);
    if (argv[0] === "teardown") return await teardownMain(flow, dryRun);

    // --dry-run spawns nothing, so the docker probe is skipped there too.
    const state = detectDirState(readCwdFile, dryRun ? null : probeDocker);
    // Hosted-cloud mode adds the prompts boot demands under IS_CLOUD=true. An
    // .env that already says so keeps the mode on re-runs without the flag.
    const cloud = argv.includes("--cloud") || isCloudEnv(state.envContent);
    flow.intro("millionsend", "setup", cloud ? "cloud" : "self-host");
    flow.note(DESCRIPTION_TEXT);
    flow.note(stateSummary(state));

    const wizard = createWizard(flow, state, cloud, state.envContent, join(process.cwd(), ".env"));
    if (dryRun) {
      const region = process.env.AWS_REGION ?? "us-east-1";
      flow.list("Plan:", flowPlan(state, { appBaseUrl: wizard.appBaseUrl(), region, cloud }));
      flow.outro("--dry-run: nothing was created, written, or started.");
      return 0;
    }
    if (wizard.interactive && setupDone(wizard.env)) return await menuLoop(wizard);
    return await walkSteps(wizard);
  } finally {
    rl.close();
  }
}

/** Every step in order, the first-run path and the "walk through every step" menu item. */
async function walkSteps(wizard: Wizard): Promise<number> {
  await envStep(wizard);
  await baseUrlsStep(wizard);
  await secretsStep(wizard);
  if (wizard.cloud) await cloudStep(wizard);
  await awsMenuStep(wizard);
  await storageStep(wizard);
  // Before launch, so the stack starts with it.
  await socialLoginStep(wizard);
  await accountEmailStep(wizard);
  // The operator's own request, not the instance's.
  await updatesStep(wizard);
  return await launchStep(wizard);
}

/**
 * The menu an already-set-up install opens on: one step at a time, back to
 * the menu after each, until the operator starts the stack or leaves.
 */
async function menuLoop(wizard: Wizard): Promise<number> {
  const { flow } = wizard;
  for (;;) {
    const options = menuOptions(wizard.env, wizard.cloud);
    const first = options[0];
    const choice = await flow.select({
      label: "This install is set up. What would you like to do?",
      ...(first ? { initial: first.value } : {}),
      options,
    });
    switch (choice) {
      case "region": {
        const queueUrl = envValue(wizard.env, "SQS_QUEUE_URL") ?? "";
        await addRegionStep(wizard, queueUrl, null);
        break;
      }
      case "aws":
        await awsMenuStep(wizard);
        break;
      case "urls":
        await baseUrlsStep(wizard);
        break;
      case "cloud":
        await cloudStep(wizard);
        break;
      case "storage":
        await storageStep(wizard);
        break;
      case "social":
        await socialLoginStep(wizard);
        break;
      case "email":
        await accountEmailStep(wizard);
        break;
      case "all":
        return await walkSteps(wizard);
      case "start":
        return await launchStep(wizard);
      default:
        flow.outro("Nothing else changed. Start or restart with: docker compose up -d");
        return 0;
    }
  }
}

const ENV_EXAMPLE_URL =
  "https://raw.githubusercontent.com/MillionSend/millionsend/main/.env.example";

/** Creates .env from the built-in template when there is none. */
async function envStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  if (wizard.env !== null) {
    flow.note(".env found — existing values are kept, setup only fills gaps.");
  } else if (
    await flow.confirm("No .env here — create one from the built-in template?", wizard.interactive)
  ) {
    wizard.env = "";
    wizard.writeEnv(freshDatabaseEntries());
    wizard.env = upsertEnv(envTemplate(), freshDatabaseEntries());
    wizard.writeEnv({});
    flow.note(`Wrote ${join(process.cwd(), ".env")}.`);
  } else {
    flow.note(`Skipped. Manual: curl -o .env ${ENV_EXAMPLE_URL}`);
  }
  if (wizard.cloud && !isCloudEnv(wizard.env)) wizard.writeEnv({ IS_CLOUD: "true" });
}

/**
 * APP_BASE_URL feeds both the .env write and the SES events transport in the
 * AWS step: every deployment gets the SQS queue the worker polls; an https
 * origin also gets a push subscription. PUBLIC_API_URL is what the dashboard
 * prints and what MCP tokens are bound to; unset it is derived as
 * <dashboard host>:3001, which only holds while the api answers on that port.
 */
async function baseUrlsStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  const appBaseUrl = await flow.ask({
    label: "APP_BASE_URL",
    hint: "the URL the dashboard is opened at; an https URL also gets SES events pushed",
    initial: wizard.appBaseUrl(),
  });
  if (wizard.env !== null && appBaseUrl !== envValue(wizard.env, "APP_BASE_URL")) {
    wizard.writeEnv({ APP_BASE_URL: appBaseUrl });
  }
  const currentApiUrl = envValue(wizard.env, "PUBLIC_API_URL") || process.env.PUBLIC_API_URL || "";
  const publicApiUrl = await flow.ask({
    label: "PUBLIC_API_URL",
    hint: "the API's public origin behind a reverse proxy; empty: port 3001 of the dashboard host",
    initial: currentApiUrl,
  });
  if (publicApiUrl !== "" && validUrl(publicApiUrl) === null) {
    flow.error(`Not a URL: ${publicApiUrl} — PUBLIC_API_URL left as it was.`);
  } else if (
    wizard.env !== null &&
    publicApiUrl !== (envValue(wizard.env, "PUBLIC_API_URL") ?? "")
  ) {
    wizard.writeEnv({ PUBLIC_API_URL: publicApiUrl });
  }
}

/** The two generated secrets, offered one by one when missing. */
async function secretsStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  if (wizard.env === null) return;
  const missing = missingSecrets(wizard.env);
  if (missing.length === 0) {
    flow.note("Secrets already set (MASTER_ENCRYPTION_KEY, BETTER_AUTH_SECRET).");
  }
  for (const key of missing) {
    const choice = await flow.select({
      label: `Generate ${key} for you?`,
      initial: wizard.interactive ? "generate" : "later",
      options: [
        { value: "generate", label: "Generate now" },
        { value: "later", label: "I'll do it later", hint: "openssl rand -base64 32" },
      ],
    });
    if (choice === "generate") {
      wizard.writeEnv({ [key]: generateSecret() });
      flow.note(`${key} written to .env.`);
    } else {
      flow.warn(secretLaterHint(key));
    }
  }
}

/**
 * Hosted-cloud additions: the values boot refuses to start without under
 * IS_CLOUD=true — the KMS key that wraps email bodies and the Stripe secrets —
 * plus the optional customer-portal id and the docs profile. Nothing here
 * touches AWS or Stripe; the values are pasted from their consoles, and an
 * empty answer keeps what .env already has.
 */
async function cloudStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  flow.note("Hosted cloud (IS_CLOUD=true) — boot needs every value below except the portal id.");
  const prompts = [
    {
      key: "KMS_KEY_ID",
      hint: "key ARN or id that wraps email bodies; the SES access key must be allowed to use it",
    },
    { key: "STRIPE_SECRET_KEY", hint: "live secret key (Stripe → Developers → API keys)" },
    {
      key: "STRIPE_WEBHOOK_SECRET",
      hint: `signing secret of the webhook endpoint at ${wizard.appBaseUrl()}/api/billing/webhook`,
    },
    {
      key: "STRIPE_PORTAL_CONFIG",
      hint: "customer-portal configuration id, bpc_… (empty: the account default)",
    },
  ] as const;
  const entries: Record<string, string> = {};
  for (const { key, hint } of prompts) {
    const current = envValue(wizard.env, key) ?? "";
    const value = await flow.ask({ label: key, hint, initial: current });
    if (value !== "" && value !== current) entries[key] = value;
  }
  if (Object.keys(entries).length > 0) {
    if (wizard.writeEnv(entries)) {
      flow.note(`${Object.keys(entries).join(", ")} written to .env.`);
    } else {
      flow.log(`No .env here — paste into .env where MillionSend runs:\n\n${pasteBlock(entries)}`);
    }
  }
  const missing = CLOUD_REQUIRED_KEYS.filter((key) => !(entries[key] ?? envValue(wizard.env, key)));
  if (missing.length > 0) {
    flow.warn(`${missing.join(", ")} still empty — IS_CLOUD=true refuses to boot without them.`);
  }
  if (
    await flow.confirm(
      "Serve the documentation site too (docs compose profile)?",
      wizard.interactive,
    )
  ) {
    if (wizard.enableProfile("docs")) flow.note("docs added to COMPOSE_PROFILES.");
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
async function socialLoginStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  const wanted = await flow.confirm(
    "Social login?",
    false,
    'Google/GitHub OAuth credentials add "Continue with …" buttons to the sign-in',
  );
  if (!wanted) {
    flow.note("Skipped — set GOOGLE_/GITHUB_CLIENT_ID and _SECRET in .env any time.");
    return;
  }
  for (const provider of SOCIAL_PROVIDERS) {
    if (!(await flow.confirm(`Set up ${provider.name} sign-in?`, false))) continue;
    flow.note(
      `Create the OAuth app: ${provider.consoleHint}\nRegister this callback URL: ${wizard.appBaseUrl()}${provider.callbackPath}`,
    );
    const id = await flow.ask({ label: provider.idKey, hint: "empty skips" });
    if (id === "") continue;
    const secret = await flow.ask({ label: provider.secretKey, secret: true });
    if (secret === "") {
      flow.note("No secret — skipped.");
      continue;
    }
    const entries = { [provider.idKey]: id, [provider.secretKey]: secret };
    if (wizard.writeEnv(entries)) {
      flow.note(`${provider.name} credentials written to .env.`);
    } else {
      flow.log(`No .env here — paste into .env where MillionSend runs:\n\n${pasteBlock(entries)}`);
    }
  }
}

/** Accepted shapes mirror packages/config parseEmailFrom; boot re-validates. */
const EMAIL_FROM_RE = /^(?:[^<>]+<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/;

const UPDATES_SUBSCRIBE_URL = "https://app.millionsend.com/api/updates/subscribe";
const UPDATES_PAGE_URL = "https://app.millionsend.com/updates";

/**
 * Optional, interactive only: the operator's one-time opt-in to release
 * notes. This is the wizard on the operator's machine asking a human and
 * posting the answer once; the instance it sets up never calls home. The
 * cloud replies with a confirmation link, so a typo enrolls nobody.
 */
async function updatesStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  if (!wizard.interactive) return;
  const value = await flow.ask({
    label: "Release notes by email?",
    hint: "your address; a confirmation link comes first, nothing else leaves this machine; empty skips",
  });
  if (value === "") return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    flow.note(`Doesn't look like an address — skipped. Subscribe any time at ${UPDATES_PAGE_URL}.`);
    return;
  }
  try {
    const res = await fetch(UPDATES_SUBSCRIBE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: value, source: "self-host" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    flow.note("Check your inbox for the confirmation link.");
  } catch {
    flow.note(`Couldn't reach millionsend.com — subscribe any time at ${UPDATES_PAGE_URL}.`);
  }
}

/**
 * Optional account-email step: the sender for password-reset mail. Env-only;
 * recovery stays hidden until this AND SES credentials are set, so skipping
 * is safe. The domain must be a verified identity — usually added later in
 * the dashboard, which is why this only sanity-checks the address shape.
 */
async function accountEmailStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  const wanted = await flow.confirm(
    "Account emails?",
    false,
    'AUTH_EMAIL_FROM sends password-reset mail; without it "Forgot password?" stays hidden',
  );
  if (!wanted) {
    flow.note(
      "Skipped — set AUTH_EMAIL_FROM (and ONBOARDING_EMAIL_FROM for the onboarding Send email button) in .env any time; their domains must be verified in the dashboard.",
    );
    return;
  }
  const value = await flow.ask({
    label: "AUTH_EMAIL_FROM",
    hint: '"Name <user@domain>" or a bare address; empty skips',
  });
  if (value === "") return;
  if (!EMAIL_FROM_RE.test(value)) {
    flow.note("Doesn't look like an address — skipped. Set AUTH_EMAIL_FROM in .env later.");
    return;
  }
  if (wizard.writeEnv({ AUTH_EMAIL_FROM: value })) {
    flow.note(
      "AUTH_EMAIL_FROM written to .env. Its domain must be a verified sending domain in this instance.",
    );
  } else {
    flow.log(`No .env here — paste into .env where MillionSend runs:\n\nAUTH_EMAIL_FROM=${value}`);
  }
}

/** null when the value does not parse as a URL — .env values zod rejects at boot. */
function validUrl(value: string): string | null {
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

/**
 * Optional object storage step: ONE S3-compatible credential set (Cloudflare
 * R2 first-class) serves both team logo uploads and the scheduled database
 * backups, each behind its own bucket. Creates/adopts both buckets over the
 * S3 API; public access for the uploads bucket cannot be enabled that way,
 * so the step prints the manual instruction and writes the S3_STORAGE_* pair
 * only once the operator has a public URL (boot rejects one without the
 * other). Every question defaults to skip; failures warn and return.
 */
async function storageStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  const wanted = await flow.confirm(
    "Object storage & backups?",
    false,
    "one S3-compatible credential set (Cloudflare R2 works out of the box) enables logo uploads and scheduled database backups",
  );
  if (!wanted) {
    flow.note("Skipped — set the S3_* block in .env any time.");
    return;
  }
  const endpoint = await flow.ask({
    label: "S3_ENDPOINT",
    hint: "R2: https://<accountid>.r2.cloudflarestorage.com; empty skips",
  });
  if (endpoint === "") return;
  if (validUrl(endpoint) === null) {
    flow.error(`Not a URL: ${endpoint} — storage step skipped.`);
    return;
  }
  const accessKeyId = await flow.ask({ label: "S3_ACCESS_KEY_ID", hint: "empty skips" });
  if (accessKeyId === "") return;
  const secretAccessKey = await flow.ask({ label: "S3_SECRET_ACCESS_KEY", secret: true });
  if (secretAccessKey === "") {
    flow.note("No secret — skipped.");
    return;
  }
  const storageBucket = await flow.ask({
    label: "Uploads bucket name",
    initial: STORAGE_BUCKET_DEFAULTS.storage,
  });
  const backupBucket = await flow.ask({
    label: "Backups bucket name",
    initial: STORAGE_BUCKET_DEFAULTS.backup,
  });

  const credentials = { endpoint, accessKeyId, secretAccessKey };
  const client = createStorageClient(credentials);
  try {
    for (const bucket of [storageBucket, backupBucket]) {
      flow.step(`bucket ${bucket}: ${await ensureBucket(client, bucket)}`);
    }
  } catch (error) {
    // Connection failures surface as AggregateErrors with an empty message.
    const reason = (error as Error).message || (error as Error).name || String(error);
    flow.error(
      `Bucket setup failed: ${reason}\nCheck the endpoint and credentials, or create the buckets yourself and set the S3_* lines in .env by hand — storage step skipped.`,
    );
    return;
  }

  flow.note(
    `Uploads serve straight from the bucket, so ${storageBucket} must serve objects publicly — the S3 API cannot enable that. R2: bucket → Settings → enable public access (or attach a custom domain), then use that URL below. Keep ${backupBucket} PRIVATE — dumps contain the whole database.`,
  );
  let publicUrl = await flow.ask({
    label: "S3_STORAGE_PUBLIC_URL",
    hint: "the bucket's public base URL; empty to add later",
  });
  if (publicUrl !== "" && validUrl(publicUrl) === null) {
    flow.error(`Not a URL: ${publicUrl} — add S3_STORAGE_PUBLIC_URL to .env later instead.`);
    publicUrl = "";
  }

  const entries = storageEnvEntries({ credentials, backupBucket, storageBucket, publicUrl });
  if (wizard.writeEnv(entries)) {
    flow.note("S3 values written to .env.");
    // The standalone compose keeps the backup service behind a profile, so
    // configuring backups also has to switch its container on.
    if (wizard.enableProfile("backup")) {
      flow.note("backup added to COMPOSE_PROFILES — the scheduled dumps start with the stack.");
    }
  } else {
    flow.log(`No .env here — paste into .env where MillionSend runs:\n\n${pasteBlock(entries)}`);
  }
  if (publicUrl === "") {
    flow.note(
      `Uploads stay off until public access is enabled and .env has S3_STORAGE_BUCKET=${storageBucket} and S3_STORAGE_PUBLIC_URL=<public URL> (set together).`,
    );
  }
}

/**
 * Verifies AWS credentials, offering a login on interactive terminals with
 * the aws CLI installed. Returns the account id, or null after the manual
 * hint. STS is global; the probe region does not constrain the SES region.
 */
async function resolveIdentity(flow: Flow): Promise<string | null> {
  const interactive = isInteractive();
  // Two login attempts, then the manual hint — a third rarely goes better.
  for (let attempt = 0; ; attempt++) {
    // Fresh client per attempt: a login may have just minted credentials,
    // and the SDK caches its credential provider per client.
    const sts = new STSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Account) throw new Error("GetCallerIdentity returned no account");
      flow.step(`aws: ${identity.Arn ?? "?"} (account ${identity.Account})`);
      return identity.Account;
    } catch (error) {
      flow.error(`Could not verify AWS credentials: ${(error as Error).message}`);
      const action = authAction({
        identityOk: false,
        // Pipes never get the offer, so skip probing for the CLI there.
        hasAwsCli: interactive && hasAwsCli(),
        isTTY: interactive,
      });
      if (action !== "offer-login" || attempt >= 2) {
        flow.error(
          "Run this where the AWS CLI/SDK finds admin credentials — `aws configure`, AWS_PROFILE, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the environment.",
        );
        return null;
      }
      const choice = await flow.select({
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
async function chooseRegion(flow: Flow): Promise<string | null> {
  const defaultRegion = process.env.AWS_REGION ?? "us-east-1";
  let region = await flow.select({
    label: "AWS region",
    initial: defaultRegion,
    options: [
      ...SES_REGIONS.map((r) => ({ value: r, label: r, hint: REGION_HINTS[r] })),
      { value: OTHER_REGION, label: "Other…", hint: "type any region" },
    ],
  });
  if (region === OTHER_REGION) {
    region = await flow.ask({ label: "AWS region", initial: defaultRegion });
  }
  if (!REGION_RE.test(region)) {
    flow.error(`Not an AWS region name: ${region}`);
    return null;
  }
  return region;
}

/**
 * The AWS decision on an install that already has some of it: add a region
 * when events and the queue exist (a full re-run only on a single-region
 * install — it rewrites the topic list and the queue policy for one region),
 * add event ingestion when only the key exists (a full re-run would mint an
 * unwanted key and can hit the 2-key IAM limit), else the first setup.
 */
async function awsMenuStep(wizard: Wizard): Promise<void> {
  const { flow } = wizard;
  const hasKeys = (envValue(wizard.env, "AWS_ACCESS_KEY_ID") ?? "") !== "";
  const hasEvents = (envValue(wizard.env, "SNS_TOPIC_ARNS") ?? "") !== "";
  const queueUrl = envValue(wizard.env, "SQS_QUEUE_URL") ?? "";
  if (hasKeys) flow.note("AWS access key already in .env.");
  if (hasEvents && queueUrl !== "") {
    const served = servedRegionsInEnv(wizard.env);
    const rerun = fullRerunOffered(wizard.env);
    const choice = await flow.select({
      label: `AWS is set up (${served.join(", ")}). Add another SES region?`,
      initial: "skip",
      options: [
        {
          value: "region",
          label: "Add a region",
          hint: "topic + configuration set there; events join the existing queue; no new key",
        },
        ...(rerun
          ? [{ value: "full", label: "Full AWS re-run", hint: "also mints a NEW access key" }]
          : []),
        { value: "skip", label: "Skip" },
      ],
    });
    if (choice === "region") {
      await addRegionStep(wizard, queueUrl, null);
    } else if (choice === "full") {
      await awsStep(wizard, false);
    } else {
      flow.note("AWS step skipped.");
      if (!rerun) {
        flow.note(
          `To rotate the access key on a multi-region install, create one for the ${SETUP_NAMES.user} IAM user in the IAM console and update .env; a full re-run here would keep only one region's events.`,
        );
      }
    }
    return;
  }
  if (hasKeys && !hasEvents) {
    const choice = await flow.select({
      label: "Event ingestion (delivered/bounce tracking) is not set up. Add it?",
      initial: wizard.interactive ? "events" : "skip",
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
    if (choice === "skip") flow.note("AWS step skipped.");
    else await awsStep(wizard, choice === "events");
    return;
  }
  const wanted = hasKeys
    ? await flow.confirm("Re-run the AWS setup?", false, "mints a NEW access key")
    : await flow.confirm(
        "Create the AWS resources now?",
        wizard.interactive,
        "IAM user + key, SNS events, SES configuration set",
      );
  if (wanted) await awsStep(wizard, false);
  else flow.note("AWS step skipped.");
}

/**
 * The AWS provisioning step: identity, region, plan, create, keys into .env.
 * eventsOnly skips the IAM part (no new access key) and provisions just the
 * events pipeline. Failures print their hint and return — the wizard
 * continues to the launch step, since a stack can boot (not send) without
 * AWS keys.
 */
async function awsStep(wizard: Wizard, eventsOnly: boolean): Promise<void> {
  const { flow } = wizard;
  const accountId = await resolveIdentity(flow);
  if (accountId === null) return;
  const region = await chooseRegion(flow);
  if (region === null) return;
  const appBaseUrl = wizard.appBaseUrl();

  flow.list("Plan:", (eventsOnly ? eventsPlan : setupPlan)({ region, appBaseUrl }));
  if (!(await flow.confirm("Proceed?", wizard.interactive))) return;

  const input = { region, accountId, appBaseUrl, onStep: (line: string) => flow.step(line) };
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
    flow.error(
      `AWS setup failed: ${(error as Error).message}\nFix that and re-run — resources it already created are adopted, not duplicated.`,
    );
    return;
  }

  if (wizard.writeEnv(entries)) {
    flow.step(`${eventsOnly ? "Event ingestion values" : "AWS keys"} written to .env.`);
  } else {
    flow.log(
      `Done. Paste into .env where MillionSend runs, then restart it:\n\n${pasteBlock(entries)}`,
    );
  }
  const origin = httpsOrigin(appBaseUrl);
  if (origin) {
    flow.note(
      "The SNS subscription confirms itself once the app runs with these values; if it stays pending, use 'Request confirmation' on it in the SNS console.",
    );
    flow.note(sesEventsProxyHint(origin, wizard.apiPort()));
  }
}

/**
 * Adds an SES region to an install that already has one. IAM is global, so
 * the user and policy are kept (the policy document is synced); the region
 * gets its own SNS topic, configuration set and bounce suppression; the topic
 * delivers into the existing events queue across regions; .env gains the
 * region and the topic ARN while AWS_REGION and SQS_QUEUE_URL stay as they
 * are. Failures print their hint and return, like the AWS step.
 */
async function addRegionStep(
  wizard: Wizard,
  queueUrl: string,
  preset: string | null,
): Promise<void> {
  const { flow } = wizard;
  const queue = parseSqsQueueUrl(queueUrl);
  if (!queue) {
    flow.error(
      `SQS_QUEUE_URL is not a standard queue URL (${queueUrl}); add the region by hand — SELF_HOSTING.md, "Adding a region".`,
    );
    return;
  }
  const accountId = await resolveIdentity(flow);
  if (accountId === null) return;
  const served = servedRegionsInEnv(wizard.env);
  const region = preset ?? (await chooseRegion(flow));
  if (region === null) return;
  if (served.includes(region)) {
    flow.note(`${region} is already served (${served.join(", ")}) — nothing to add.`);
    return;
  }
  const appBaseUrl = wizard.appBaseUrl();

  flow.list("Plan:", addRegionPlan({ region, queueUrl, appBaseUrl }));
  if (!(await flow.confirm("Proceed?", wizard.interactive))) return;

  const clients = createSetupClients(region, queue.region);
  const onStep = (line: string): void => flow.step(line);
  let topicArn: string;
  try {
    onStep(`IAM policy ${SETUP_NAMES.policy}`);
    try {
      if (await syncAdoptedPolicy(clients.iam, setupPolicyArn(accountId))) {
        onStep(`IAM policy ${SETUP_NAMES.policy}: updated to the current document`);
      }
    } catch (error) {
      // An install that brought its own IAM (the events-only path) has no
      // wizard-named policy; the region's resources need none.
      if ((error as { name?: string }).name !== "NoSuchEntityException") throw error;
      onStep(
        `IAM policy ${SETUP_NAMES.policy}: not found, this install brought its own IAM — kept`,
      );
    }
    const existingTopics = (envValue(wizard.env, "SNS_TOPIC_ARNS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    ({ topicArn } = await runEventsSetup(clients, {
      region,
      accountId,
      appBaseUrl,
      onStep,
      existingQueue: { url: queueUrl, topicArns: existingTopics },
    }));
  } catch (error) {
    flow.error(
      `Adding the region failed: ${(error as Error).message}\nFix that and re-run — resources it already created are adopted, not duplicated.`,
    );
    return;
  }
  await essentialsPlanPrompt(flow, clients.ses, region);

  const entries = addRegionEnvEntries(wizard.env, region, topicArn);
  if (wizard.writeEnv(entries)) {
    flow.step(
      `${region} added to .env (AWS_REGIONS, SNS_TOPIC_ARNS). Restart the stack (docker compose up -d) so the worker and dashboard pick it up; the region reads as Sandbox until AWS grants production access there.`,
    );
  } else {
    flow.log(
      `Done. Paste into .env where MillionSend runs, then restart it:\n\n${pasteBlock(entries)}`,
    );
  }
  if (httpsOrigin(appBaseUrl)) {
    flow.note(
      "The SNS subscription confirms itself once the app runs with these values; if it stays pending, use 'Request confirmation' on it in the SNS console.",
    );
  }
}

/**
 * `setup add-region [region]`: the add-region step on its own, without the
 * rest of the wizard. Where the install's .env is — the deploy directory, or
 * the container's `setup` mode on the server — it edits that file; anywhere
 * else it asks for the install's queue, topics and regions and prints the
 * two lines to apply. --dry-run prints the plan and touches nothing.
 */
async function addRegionMain(flow: Flow, args: string[], dryRun: boolean): Promise<number> {
  const preset = args.find((arg) => !arg.startsWith("--")) ?? null;
  if (preset !== null && !REGION_RE.test(preset)) {
    flow.error(`Not an AWS region name: ${preset}`);
    return 1;
  }
  flow.intro("millionsend", "add-region", preset ?? undefined);
  const envPath = join(process.cwd(), ".env");
  const state = detectDirState(readCwdFile, null);
  let queueUrl = envValue(state.envContent, "SQS_QUEUE_URL") || process.env.SQS_QUEUE_URL || "";
  if (state.envContent !== null && queueUrl === "") {
    flow.error("This .env has no SQS_QUEUE_URL — run the full setup first, then add regions.");
    return 1;
  }
  if (dryRun) {
    const wizard = createWizard(flow, state, false, state.envContent, null);
    flow.list(
      "Plan:",
      addRegionPlan({
        region: preset ?? "<region>",
        queueUrl: queueUrl || "<SQS_QUEUE_URL>",
        appBaseUrl: envValue(state.envContent, "APP_BASE_URL") || process.env.APP_BASE_URL || "",
      }),
    );
    flow.outro(`--dry-run: nothing was created or written${wizard.env ? "" : " (no .env here)"}.`);
    return 0;
  }
  if (state.envContent === null) {
    flow.note(
      "No .env here — the install's current values are asked for and the result is printed, not written.",
    );
    queueUrl =
      queueUrl || (await flow.ask({ label: "SQS_QUEUE_URL", hint: "the install's events queue" }));
    if (queueUrl === "") {
      flow.error("An events queue is required: the new region's topic delivers into it.");
      return 1;
    }
    const topics = await flow.ask({
      label: "SNS_TOPIC_ARNS",
      hint: "the topic ARNs the install already allows, comma-separated",
    });
    if (topics === "") {
      flow.error(
        "The queue policy is rewritten with the topics listed here; an empty list would cut off the existing regions' events.",
      );
      return 1;
    }
    const regions = await flow.ask({
      label: "AWS_REGIONS",
      hint: "the regions the install serves today, comma-separated",
      initial: parseSqsQueueUrl(queueUrl)?.region ?? "",
    });
    const appBaseUrl = await flow.ask({
      label: "APP_BASE_URL",
      hint: "for the optional https push of events; empty: queue only",
      initial: process.env.APP_BASE_URL ?? "",
    });
    const env = upsertEnv("", {
      AWS_REGIONS: regions,
      SNS_TOPIC_ARNS: topics,
      SQS_QUEUE_URL: queueUrl,
      ...(appBaseUrl ? { APP_BASE_URL: appBaseUrl } : {}),
    });
    // No path: nothing is written, the step prints the lines instead.
    const wizard = createWizard(flow, state, false, env, null);
    await addRegionStep(wizard, queueUrl, preset);
    return 0;
  }
  flow.note(`Found ${envPath} — the region is written into it.`);
  const wizard = createWizard(flow, state, isCloudEnv(state.envContent), state.envContent, envPath);
  await addRegionStep(wizard, queueUrl, preset);
  return 0;
}

/**
 * A region with no prior sending starts on the Essentials plan, which costs
 * more per message than à la carte: say so and offer the cancel. Nothing is
 * changed without an explicit yes; a plan that cannot be read is left alone.
 * Exported for tests.
 */
export async function essentialsPlanPrompt(
  flow: Flow,
  ses: SetupSesClient,
  region: string,
): Promise<"kept" | "cancelled" | "not_essentials" | "unknown"> {
  let plan: string | null;
  try {
    plan = await readPricingPlan(ses);
  } catch (error) {
    flow.note(`Could not read the SES pricing plan in ${region}: ${(error as Error).message}`);
    return "unknown";
  }
  if (plan !== "ESSENTIALS") return "not_essentials";
  flow.warn(`Pricing plan: ${ESSENTIALS_WARNING}`);
  if (!(await flow.confirm(`Cancel the Essentials plan in ${region} now?`, false, "Plan=NONE"))) {
    flow.note(
      `Kept. Cancel later with: aws sesv2 put-account-pricing-attributes --plan NONE --region ${region}`,
    );
    return "kept";
  }
  try {
    await cancelPricingPlan(ses);
    flow.step(`${region} is now on à la carte SES pricing.`);
    return "cancelled";
  } catch (error) {
    flow.error(
      `Cancel failed: ${(error as Error).message}\nCancel it in the SES console (Pricing plan → Cancel plan) or with the CLI line above.`,
    );
    return "kept";
  }
}

async function download(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** The launch step: optional compose download, then docker compose up. */
async function launchStep(wizard: Wizard): Promise<number> {
  const { flow, state } = wizard;
  if (state.docker === null) {
    flow.outro(
      "docker not found — install it (https://docs.docker.com/get-docker/), then run: docker compose up -d",
    );
    return 0;
  }
  const choice = await flow.select({
    label: "Start MillionSend now?",
    initial: wizard.interactive ? "start" : "later",
    options: [
      { value: "start", label: "Start", hint: "docker compose up" },
      { value: "later", label: "Later" },
    ],
  });

  let composeContent = state.composeContent;
  if (choice === "start" && composeContent === null) {
    if (
      await flow.confirm(
        "No compose file here — download the standalone deploy/docker-compose.yml?",
        wizard.interactive,
      )
    ) {
      try {
        composeContent = await download(COMPOSE_DOWNLOAD_URL);
        writeFileSync(join(process.cwd(), "docker-compose.yml"), composeContent);
        flow.step("Wrote docker-compose.yml.");
      } catch (error) {
        flow.error(`Download failed (${(error as Error).message}).`);
      }
    }
  }

  const command = `docker ${composeUpArgs(composeContent).join(" ")}`;
  if (choice !== "start" || composeContent === null) {
    const curl =
      composeContent === null && state.composeFile === null
        ? `\n  curl -O ${COMPOSE_DOWNLOAD_URL}`
        : "";
    flow.outro(`Start later with:${curl}\n  ${command}`);
    return 0;
  }

  const secretsMissing = wizard.env === null ? [] : missingSecrets(wizard.env);
  if (secretsMissing.length > 0) {
    flow.warn(`${secretsMissing.join(", ")} still empty in .env — the app needs them.`);
  }
  flow.step(`$ ${command}`);
  if (!runInherit("docker", composeUpArgs(composeContent))) {
    flow.error("docker compose failed — fix the error above and re-run the setup.");
    return 1;
  }
  const appBaseUrl = wizard.appBaseUrl();
  const origin = httpsOrigin(appBaseUrl);
  flow.outro(
    [
      "Running. Next steps:",
      `  · ${appBaseUrl} — sign up (the first user becomes the owner)`,
      "  · SES sandbox account? Recipients must be verified until AWS grants production access",
      "  · Verify a sending domain in the dashboard, then send",
      ...(origin
        ? [
            `  · Reverse proxy in front? Route ${origin}/ses/events to the api (SELF_HOSTING.md, SES events)`,
          ]
        : []),
    ].join("\n"),
  );
  return 0;
}

/** The pre-wizard teardown flow, unchanged: identity, region, delete. */
async function teardownMain(flow: Flow, dryRun: boolean): Promise<number> {
  flow.intro("millionsend", "teardown");
  let accountId = "";
  if (dryRun) {
    flow.note("--dry-run: skipping the AWS credential check.");
  } else {
    const resolved = await resolveIdentity(flow);
    if (resolved === null) return 1;
    accountId = resolved;
  }
  const region = await chooseRegion(flow);
  if (region === null) return 1;
  flow.list("Teardown deletes:", teardownPlan(region));
  if (dryRun) {
    flow.outro("--dry-run: nothing was deleted.");
    return 0;
  }
  if (!(await flow.confirm("Delete these?", false, "the access keys stop working immediately"))) {
    return 1;
  }
  await runTeardown(createSetupClients(region), {
    region,
    accountId,
    onStep: (line) => flow.step(`deleting ${line}`),
  });
  flow.outro("Done. Remove the AWS_* / SNS_TOPIC_ARNS / SES_CONFIGURATION_SET lines from .env.");
  return 0;
}
