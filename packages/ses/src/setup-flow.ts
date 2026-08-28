// Pure, testable pieces of the end-to-end self-host wizard: directory state
// detection, plan assembly, secret policy, and the compose-command choice.
// I/O stays in setup-cli.ts; everything here takes injected readers/probes.
import { randomBytes } from "node:crypto";
import { setupPlan, upsertEnv } from "./setup.js";

/** Compose file names `docker compose` picks up on its own, most common first. */
export const COMPOSE_FILENAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

export const COMPOSE_DOWNLOAD_URL =
  "https://raw.githubusercontent.com/MillionSend/millionsend/main/deploy/docker-compose.yml";

/** .env keys the wizard offers to generate when missing or empty. */
export const SECRET_KEYS = ["MASTER_ENCRYPTION_KEY", "BETTER_AUTH_SECRET"] as const;

export interface DirState {
  /** null = no .env in the directory. */
  envContent: string | null;
  /** First compose file name found, or null. */
  composeFile: string | null;
  composeContent: string | null;
  /** Version label when docker compose answered, null when absent or unprobed. */
  docker: string | null;
  /** false when the probe was skipped (--dry-run spawns nothing). */
  dockerProbed: boolean;
}

/**
 * Reads the directory state through injected seams: `readFile` returns file
 * content or null, `probeDocker` returns a version label or null — pass
 * probeDocker as null to skip the probe entirely (--dry-run).
 */
export function detectDirState(
  readFile: (name: string) => string | null,
  probeDocker: (() => string | null) | null,
): DirState {
  const composeFile = COMPOSE_FILENAMES.find((name) => readFile(name) !== null) ?? null;
  return {
    envContent: readFile(".env"),
    composeFile,
    composeContent: composeFile === null ? null : readFile(composeFile),
    docker: probeDocker === null ? null : probeDocker(),
    dockerProbed: probeDocker !== null,
  };
}

/** Deadpan one-line status block, e.g. "found .env · no compose file · docker compose v2.32". */
export function stateSummary(state: DirState): string {
  const docker = !state.dockerProbed
    ? "docker not checked"
    : state.docker === null
      ? "docker not found"
      : state.docker;
  return [
    state.envContent === null ? "no .env" : "found .env",
    state.composeFile === null ? "no compose file" : `found ${state.composeFile}`,
    docker,
  ].join(" · ");
}

/**
 * First value of `KEY=...` in dotenv content, tolerating the same variants as
 * upsertEnv (whitespace, `export `, spaces around `=`). null = line absent;
 * "" = present but empty.
 */
export function envValue(content: string | null, key: string): string | null {
  if (content === null) return null;
  for (const line of content.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] === key) return (match[2] ?? "").trim();
  }
  return null;
}

/** The wizard-managed secrets that are missing or empty in the given .env content. */
export function missingSecrets(content: string): string[] {
  return SECRET_KEYS.filter((key) => !envValue(content, key));
}

/** Same shape the .env.example comments suggest: openssl rand -base64 32. */
export function generateSecret(): string {
  return randomBytes(32).toString("base64");
}

/** Printed when the operator defers a secret to generate it themselves. */
export function secretLaterHint(key: string): string {
  return `${key} left empty — before starting, run: openssl rand -base64 32  and put it in .env`;
}

/**
 * Yes/no answer with a caller-chosen empty-answer default: interactive
 * terminals default each offer to yes, pipes default to no so scripted runs
 * skip every step deterministically.
 */
export function confirmed(answer: string, defaultYes: boolean): boolean {
  const trimmed = answer.trim();
  if (trimmed === "") return defaultYes;
  return /^y(es)?$/i.test(trimmed);
}

/**
 * argv after `docker` that starts the stack: a compose file with a build key
 * (repo clone) needs --build so code changes land; the deploy compose pulls.
 */
export function composeUpArgs(composeContent: string | null): string[] {
  const build = composeContent !== null && /^\s*build\s*:/m.test(composeContent);
  return build ? ["compose", "up", "--build", "-d"] : ["compose", "up", "-d"];
}

/**
 * Turns an optional compose service on by editing COMPOSE_PROFILES, so the
 * wizard step that configures a feature also starts its container; a
 * profile already listed is left alone.
 */
export function withComposeProfile(content: string, profile: string): string {
  const names = (envValue(content, "COMPOSE_PROFILES") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.includes(profile)) return content;
  return upsertEnv(content, { COMPOSE_PROFILES: [...names, profile].join(",") });
}

/**
 * SES events are ingested by the api process, but the one public URL the
 * setup knows is the dashboard origin, so SNS is subscribed there. A reverse
 * proxy in front of the dashboard has to hand that single path to the api,
 * or the confirmation POST 404s and no bounce or delivery ever arrives.
 */
export function sesEventsProxyHint(origin: string, apiPort = 3001): string {
  return [
    `SNS delivers SES events to ${origin}/ses/events, and the api process serves that path.`,
    "A reverse proxy in front of the dashboard must route it to the api — nginx:",
    "",
    `    location = /ses/events { proxy_pass http://127.0.0.1:${apiPort}; }`,
    "",
    "Without that the subscription stays pending and no delivery or bounce event arrives.",
  ].join("\n");
}

/** The full multi-step plan --dry-run prints; mirrors what the live run offers. */
export function flowPlan(state: DirState, opts: { appBaseUrl: string; region: string }): string[] {
  const lines: string[] = [];
  lines.push(
    state.envContent === null
      ? "env: create .env from the built-in template (offered)"
      : "env: keep the existing .env — setup only fills gaps",
  );
  const missing = state.envContent === null ? [...SECRET_KEYS] : missingSecrets(state.envContent);
  lines.push(
    missing.length === 0
      ? `secrets: ${SECRET_KEYS.join(" and ")} already set`
      : `secrets: offer to generate ${missing.join(" and ")}`,
  );
  lines.push(`env: APP_BASE_URL prompt (default ${opts.appBaseUrl})`);
  lines.push(
    "env: PUBLIC_API_URL prompt (optional — the API's own hostname behind a reverse proxy)",
  );
  for (const line of setupPlan({ region: opts.region, appBaseUrl: opts.appBaseUrl })) {
    lines.push(`aws: ${line}`);
  }
  const upCommand = `docker ${composeUpArgs(state.composeContent).join(" ")}`;
  lines.push(
    state.composeFile === null
      ? `launch: offer to download deploy/docker-compose.yml, then ${upCommand}`
      : `launch: offer ${upCommand} (${state.composeFile})`,
  );
  return lines;
}
