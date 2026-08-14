import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
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

const BANNER = [
  "millionsend · aws setup",
  "Creates the IAM user, policy, access key — and, with an https APP_BASE_URL,",
  "the SNS event topic and SES configuration set. Run it where YOUR admin AWS",
  "credentials live: this machine, or the server. It never needs the app running.",
].join("\n");

const REGION_RE = /^[a-z0-9][a-z0-9-]*$/;

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
      output.write(prompt);
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

/**
 * Interactive entry point behind `pnpm setup:aws` and the container's
 * `setup` argv mode (scripts/aws-setup/index.ts wires it up).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const teardown = argv[0] === "teardown";
  const dryRun = argv.includes("--dry-run");
  const rl = lineReader();
  try {
    console.log(`${BANNER}\n`);

    // Identity first: everything else is pointless without working credentials.
    // STS is global; the probe region does not constrain the region prompted below.
    // --dry-run never touches AWS, so the probe (and its client) is skipped too.
    let accountId = "";
    if (dryRun) {
      console.log("--dry-run: skipping the AWS credential check.\n");
    } else {
      const sts = new STSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
      try {
        const identity = await sts.send(new GetCallerIdentityCommand({}));
        if (!identity.Account) throw new Error("GetCallerIdentity returned no account");
        accountId = identity.Account;
        console.log(`AWS identity: ${identity.Arn ?? "?"} (account ${accountId})\n`);
      } catch (error) {
        console.error(`Could not verify AWS credentials: ${(error as Error).message}`);
        console.error(
          "Run this where the AWS CLI/SDK finds admin credentials — `aws configure`, AWS_PROFILE, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the environment.",
        );
        return 1;
      }
    }

    const defaultRegion = process.env.AWS_REGION ?? "us-east-1";
    const region = (await rl.question(`AWS region [${defaultRegion}]: `)).trim() || defaultRegion;
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
