import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { SES_REGIONS, type SesRegion } from "./domain-identity.js";
import {
  createSetupClients,
  httpsOrigin,
  runSetup,
  runTeardown,
  setupEnvEntries,
  setupPlan,
  teardownPlan,
  upsertEnv,
} from "./setup.js";
import { banner, dim, pickBannerTier, selectPrompt } from "./tty-ui.js";

const DESCRIPTION = [
  "Creates the IAM user, policy, access key — and, with an https APP_BASE_URL,",
  "the SNS event topic and SES configuration set. Run it where YOUR admin AWS",
  "credentials live: this machine, or the server. It never needs the app running.",
].join("\n");

const BANNER = `millionsend · aws setup\n\n${DESCRIPTION}`;

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

function runAws(args: string[]): void {
  // The prompt UI holds the terminal in raw mode; hand the child a sane tty.
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  spawnSync("aws", args, { stdio: "inherit" });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
}

function printHeader(): void {
  const tier = pickBannerTier(process.stdout.columns ?? 0, process.stdout.isTTY === true);
  if (tier === "plain") {
    console.log(`${BANNER}\n`);
    return;
  }
  for (const line of banner(tier)) console.log(line);
  console.log(`\n${dim(DESCRIPTION)}\n`);
}

/**
 * Interactive entry point behind `pnpm setup:aws` and the container's
 * `setup` argv mode (scripts/aws-setup/index.ts wires it up).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const teardown = argv[0] === "teardown";
  const dryRun = argv.includes("--dry-run");
  const rl = lineReader();
  try {
    printHeader();

    // Identity first: everything else is pointless without working credentials.
    // STS is global; the probe region does not constrain the region prompted below.
    // --dry-run never touches AWS, so the probe (and its client) is skipped too.
    let accountId = "";
    if (dryRun) {
      console.log("--dry-run: skipping the AWS credential check.\n");
    } else {
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      // Two login attempts, then the manual hint — a third rarely goes better.
      for (let attempt = 0; ; attempt++) {
        // Fresh client per attempt: a login may have just minted credentials,
        // and the SDK caches its credential provider per client.
        const sts = new STSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
        try {
          const identity = await sts.send(new GetCallerIdentityCommand({}));
          if (!identity.Account) throw new Error("GetCallerIdentity returned no account");
          accountId = identity.Account;
          console.log(`${dim(`aws: ${identity.Arn ?? "?"} (account ${accountId})`)}\n`);
          break;
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
            return 1;
          }
          const choice = await selectPrompt(rl, {
            label: "Not authenticated",
            initial: "sso",
            options: [
              { value: "sso", label: "Run aws sso login" },
              { value: "configure", label: "Run aws configure" },
              { value: "exit", label: "Exit" },
            ],
          });
          if (choice === "exit") return 1;
          runAws(choice === "sso" ? ["sso", "login"] : ["configure"]);
        }
      }
    }

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
      return 1;
    }

    if (teardown) return await teardownFlow(rl, region, accountId, dryRun);

    const defaultBase = process.env.APP_BASE_URL ?? "";
    const answer = (
      await rl.question(
        `APP_BASE_URL for event ingestion (https URL, empty skips events) [${defaultBase || "skip"}]: `,
      )
    ).trim();
    const appBaseUrl = answer || defaultBase;
    if (appBaseUrl && !httpsOrigin(appBaseUrl)) {
      console.log(`Not an https URL (${appBaseUrl}) — the events part is skipped.`);
    }

    console.log("\nPlan:");
    for (const line of setupPlan({ region, appBaseUrl })) console.log(`  · ${line}`);
    if (dryRun) {
      console.log("\n--dry-run: nothing was created.");
      return 0;
    }

    if (!(await confirm(rl, "\nProceed?"))) return 1;

    const result = await runSetup(createSetupClients(region), {
      region,
      accountId,
      appBaseUrl,
      onStep: (line) => console.log(`==> ${line}`),
    });

    const entries = setupEnvEntries(region, result);
    const block = Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    console.log(`\nDone. Paste into .env where MillionSend runs, then restart it:\n\n${block}\n`);
    if (result.topicArn) {
      console.log(
        "The SNS subscription confirms itself once the app runs with these values;\nif it stays pending, use 'Request confirmation' on it in the SNS console.\n",
      );
    }

    const envPath = join(process.cwd(), ".env");
    if (existsSync(envPath) && (await confirm(rl, `Update ${envPath} in place?`))) {
      writeFileSync(envPath, upsertEnv(readFileSync(envPath, "utf8"), entries));
      console.log("Updated. Restart the app to pick it up.");
    }
    return 0;
  } finally {
    rl.close();
  }
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
  return /^y(es)?$/i.test((await rl.question(`${prompt} [y/N] `)).trim());
}
