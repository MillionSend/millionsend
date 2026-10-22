// Self-host process supervisor. PROCESS selects what runs in this container:
// api | worker | web | smtp | docs | mx | all (default all). Migrations run
// first so a fresh database is usable on first boot — except for docs and mx
// containers, which have no database at all. "all" excludes smtp, docs and
// mx — each is opt-in via its own compose service.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// ponytail: tsx at runtime is the ceiling here — it resolves NodeNext ".js"
// specifiers to .ts sources, which node --experimental-strip-types cannot.
// Precompiled dist images are the upgrade path if boot time or image size hurts.
// Node runs each entry with its package's tsx loader (pnpm links tsx into each
// dependent package, not the workspace root). Not tsx's CLI: its parent process
// SIGKILLs the entry when a relayed SIGTERM isn't acknowledged within 30 ms,
// so a process busy at that moment would be killed instead of draining.
function tsxEntry(pkg, entry) {
  const loader = createRequire(join(root, pkg, "package.json")).resolve("tsx");
  return {
    command: process.execPath,
    args: ["--import", pathToFileURL(loader).href, join(root, entry)],
  };
}

const PROCESSES = {
  api: { ...tsxEntry("apps/api", "apps/api/src/server.ts"), cwd: root, env: {} },
  worker: {
    ...tsxEntry("apps/worker", "apps/worker/src/server.ts"),
    cwd: root,
    // Setting glibc's mmap threshold switches off its dynamic raise (to each
    // freed mmapped block's size, up to 32 MiB). Raised, the media threads'
    // multi-MB image buffers land in malloc heaps that are never handed back,
    // so the worker's memory only climbs; at the 128 KiB default they are
    // mmapped and returned when freed.
    env: { MALLOC_MMAP_THRESHOLD_: "131072" },
  },
  web: {
    command: join(root, "apps/web/node_modules/.bin/next"),
    args: ["start"],
    cwd: join(root, "apps/web"),
    // PORT belongs to the api (default 3001); the web process is fixed at 3000.
    env: { PORT: "3000" },
  },
  smtp: { ...tsxEntry("apps/smtp", "apps/smtp/src/server.ts"), cwd: root, env: {} },
  docs: {
    command: join(root, "apps/docs/node_modules/.bin/next"),
    args: ["start"],
    cwd: join(root, "apps/docs"),
    // DOCS_PORT remaps only the host side; the docs process is fixed at 3002.
    env: { PORT: "3002" },
  },
  // The inbound MX: hands every message to the app over HTTPS, so it holds
  // no database and boots with only its MX_* variables.
  mx: { ...tsxEntry("apps/mx", "apps/mx/src/server.ts"), cwd: root, env: {} },
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
  const { command, args } = tsxEntry("packages/db", "scripts/aws-setup/index.ts");
  const cli = spawnSync(command, [...args, ...process.argv.slice(3)], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  process.exit(cli.status ?? 1);
}

function runMigrations() {
  const { command, args } = tsxEntry("packages/db", "packages/db/src/migrate.ts");
  return spawnSync(command, args, { cwd: root, stdio: "inherit" });
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
