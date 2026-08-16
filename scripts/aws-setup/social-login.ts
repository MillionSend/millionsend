// Optional post-wizard step: Google/GitHub OAuth credentials for the
// dashboard's social sign-in buttons. It lives beside the entry (not in
// packages/ses) because it touches no AWS resource — it only persists env
// values the web process reads. Reuses the wizard's line reader and .env
// upsert so answers and writes behave exactly like every other step.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertEnv } from "../../packages/ses/src/setup.js";
import { lineReader } from "../../packages/ses/src/setup-cli.js";
import { confirmed, envValue } from "../../packages/ses/src/setup-flow.js";
import { dim } from "../../packages/ses/src/tty-ui.js";

const PROVIDERS = [
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
 * Prompts for the four social-login env values and upserts them into ./.env.
 * Every question defaults to skip, so piped/EOF runs sail through unchanged.
 */
export async function socialLoginStep(): Promise<void> {
  const rl = lineReader();
  try {
    const envPath = join(process.cwd(), ".env");
    let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
    const appBaseUrl =
      envValue(env, "APP_BASE_URL") || process.env.APP_BASE_URL || "http://localhost:3000";

    console.log("");
    const wanted = confirmed(
      await rl.question(
        'Optional: social login. Google/GitHub OAuth credentials add "Continue with …" buttons to the dashboard sign-in. Configure now? [y/N] ',
      ),
      false,
    );
    if (!wanted) {
      console.log(dim("Skipped — set GOOGLE_/GITHUB_CLIENT_ID and _SECRET in .env any time."));
      return;
    }

    let wrote = false;
    for (const provider of PROVIDERS) {
      if (!confirmed(await rl.question(`\nSet up ${provider.name} sign-in? [y/N] `), false)) {
        continue;
      }
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
      if (env === null) {
        const block = Object.entries(entries)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");
        console.log(`No .env here — paste into .env where MillionSend runs:\n\n${block}\n`);
      } else {
        env = upsertEnv(env, entries);
        writeFileSync(envPath, env);
        console.log(dim(`${provider.name} credentials written to .env.`));
        wrote = true;
      }
    }
    if (wrote) {
      console.log("Restart MillionSend (docker compose up -d) to enable the buttons.");
    }
  } finally {
    rl.close();
  }
}
