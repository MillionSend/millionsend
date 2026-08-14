// Self-host process supervisor. PROCESS selects what runs in this container:
// api | worker | web | all (default all). Migrations always run first so a
// fresh database is usable on first boot.
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
};

// "setup" argv mode runs the interactive AWS setup CLI instead of the app:
//   docker compose run --rm millionsend setup [teardown] [--dry-run]
// (the Dockerfile ENTRYPOINT forwards compose run args here).
if (process.argv[2] === "setup") {
  const cli = spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [join(root, "scripts/aws-setup/index.ts"), ...process.argv.slice(3)],
    { cwd: root, stdio: "inherit" },
  );
  process.exit(cli.status ?? 1);
}

// biome-ignore lint/suspicious/noUndeclaredEnvVars: container runtime selector, never read under turbo
const selection = process.env.PROCESS ?? "all";
const names = selection === "all" ? Object.keys(PROCESSES) : [selection];
for (const name of names) {
  if (!PROCESSES[name]) {
    console.error(`start: unknown PROCESS "${selection}" (expected api | worker | web | all)`);
    process.exit(1);
  }
}

const migrate = spawnSync(
  join(root, "packages/db/node_modules/.bin/tsx"),
  [join(root, "packages/db/src/migrate.ts")],
  { cwd: root, stdio: "inherit" },
);
if (migrate.status !== 0) {
  console.error("start: migrations failed, not starting processes");
  process.exit(migrate.status ?? 1);
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
  // Give children time to exit cleanly, then force the container down.
  setTimeout(() => process.exit(exitCode), 10_000).unref();
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
