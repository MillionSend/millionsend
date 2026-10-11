// Self-host process supervisor. PROCESS selects what runs in this container:
// api | worker | web | smtp | docs | mx | all (default all). Migrations run
// first so a fresh database is usable on first boot — except for docs and mx
// containers, which have no database at all. "all" excludes smtp, docs and
// mx — each is opt-in via its own compose service.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// ponytail: tsx at runtime is the ceiling here — it resolves NodeNext ".js"
// specifiers to .ts sources, which node --experimental-strip-types cannot.
// Precompiled dist images are the upgrade path if boot time or image size hurts.
// Per-package .bin paths because pnpm links tsx into each dependent package,
// not the workspace root.
const PROCESSES = {
  api: {
    command: join(root, "apps/api/node_modules/.bin/tsx"),
    args: [join(root, "apps/api/src/server.ts")],
    cwd: root,
    env: {},
  },
  worker: {
    command: join(root, "apps/worker/node_modules/.bin/tsx"),
    args: [join(root, "apps/worker/src/server.ts")],
    cwd: root,
    env: {},
  },
  web: {
    command: join(root, "apps/web/node_modules/.bin/next"),
    args: ["start"],
    cwd: join(root, "apps/web"),
    // PORT belongs to the api (default 3001); the web process is fixed at 3000.
    env: { PORT: "3000" },
  },
  smtp: {
    command: join(root, "apps/smtp/node_modules/.bin/tsx"),
    args: [join(root, "apps/smtp/src/server.ts")],
    cwd: root,
    env: {},
  },
  docs: {
    command: join(root, "apps/docs/node_modules/.bin/next"),
    args: ["start"],
    cwd: join(root, "apps/docs"),
    // DOCS_PORT remaps only the host side; the docs process is fixed at 3002.
    env: { PORT: "3002" },
  },
  // The inbound MX: hands every message to the app over HTTPS, so it holds
  // no database and boots with only its MX_* variables.
  mx: {
    command: join(root, "apps/mx/node_modules/.bin/tsx"),
    args: [join(root, "apps/mx/src/server.ts")],
    cwd: root,
    env: {},
  },
};

// Processes that never touch the database: a container running only these
// boots without DATABASE_URL and skips migrations.
const DATABASE_FREE = new Set(["docs", "mx"]);

const ALL_PROCESSES = ["api", "worker", "web"];

// "setup" argv mode runs the interactive setup wizard instead of the app:
//   docker run --rm -it -v "$PWD":/work -w /work <image> setup [--cloud] [add-region <region>] [teardown] [--dry-run]
// (the Dockerfile ENTRYPOINT forwards the args here). The wizard reads and
// writes .env in the working directory, so -w decides where that is; the
// script path is absolute and resolves the same from any cwd.
if (process.argv[2] === "setup") {
  const cli = spawnSync(
    join(root, "packages/db/node_modules/.bin/tsx"),
    [join(root, "scripts/aws-setup/index.ts"), ...process.argv.slice(3)],
    { cwd: process.cwd(), stdio: "inherit" },
  );
  process.exit(cli.status ?? 1);
}

function runMigrations() {
  return spawnSync(
    join(root, "packages/db/node_modules/.bin/tsx"),
    [join(root, "packages/db/src/migrate.ts")],
    { cwd: root, stdio: "inherit" },
  );
}

// "migrate" argv mode runs pending migrations and exits without starting any
// process. Migrations lock the tables they touch, so a slow one is downtime
// either way; running it here, before `up -d`, means a failure leaves the
// old container serving instead of a container that will not boot, and the
// boot-time pass then finds nothing pending:
//   docker compose run --rm --no-deps millionsend migrate
if (process.argv[2] === "migrate") {
  process.exit(runMigrations().status ?? 1);
}

// biome-ignore lint/suspicious/noUndeclaredEnvVars: container runtime selector, never read under turbo
const selection = process.env.PROCESS ?? "all";
const names = selection === "all" ? ALL_PROCESSES : [selection];
for (const name of names) {
  if (!PROCESSES[name]) {
    console.error(
      `start: unknown PROCESS "${selection}" (expected api | worker | web | smtp | docs | mx | all)`,
    );
    process.exit(1);
  }
}

if (names.some((name) => !DATABASE_FREE.has(name))) {
  const migrate = runMigrations();
  if (migrate.status !== 0) {
    console.error("start: migrations failed, not starting processes");
    process.exit(migrate.status ?? 1);
  }
}

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function prefixPipe(stream, name, out) {
  createInterface({ input: stream }).on("line", (line) => {
    out.write(`[${name}] ${line}\n`);
  });
}

function shutdown(signal, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (children.size === 0) process.exit(exitCode);
  for (const child of children.values()) child.kill(signal);
  // Give children time to exit cleanly, then force the container down. The
  // worker drains in-flight jobs for up to 30 s (pg-boss graceful stop); a
  // shorter budget here would kill a send between its claim and SES accept.
  // Compose's stop_grace_period must stay above this.
  setTimeout(() => process.exit(exitCode), 35_000).unref();
}

for (const name of names) {
  const spec = PROCESSES[name];
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(name, child);
  prefixPipe(child.stdout, name, process.stdout);
  prefixPipe(child.stderr, name, process.stderr);
  child.on("exit", (code, signal) => {
    children.delete(name);
    console.error(`start: ${name} exited (code=${code} signal=${signal})`);
    if (shuttingDown) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    // One process dying takes the container down so the orchestrator restarts it whole.
    shutdown("SIGTERM", code === 0 ? 1 : (code ?? 1));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));
