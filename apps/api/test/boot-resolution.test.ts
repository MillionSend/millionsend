// Pins the production boot path: scripts/start.mjs spawns each entrypoint via
// its package-local tsx bin because tsx resolves NodeNext ".js" specifiers to
// .ts sources, which `node --experimental-strip-types` cannot
// (ERR_MODULE_NOT_FOUND at load). Vitest's own resolver would mask that, so
// these tests spawn the real bins the supervisor uses.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

// Empty-string env values keep the entrypoints on their fast fail-early paths
// (missing-secret / missing-DATABASE_URL) instead of starting real listeners.
const env = {
  ...process.env,
  SKIP_ENV_VALIDATION: "1",
  MASTER_ENCRYPTION_KEY: "",
  DATABASE_URL: "",
};

const ENTRYPOINTS = [
  { pkg: "apps/api", entry: "apps/api/src/server.ts" },
  { pkg: "apps/worker", entry: "apps/worker/src/server.ts" },
  { pkg: "apps/smtp", entry: "apps/smtp/src/server.ts" },
  { pkg: "packages/db", entry: "packages/db/src/migrate.ts" },
];

function boot(pkg: string, entry: string, extraEnv: Record<string, string> = {}): string {
  const bin = join(root, pkg, "node_modules/.bin/tsx");
  expect(existsSync(bin), `${pkg} must depend on tsx (bin missing)`).toBe(true);
  const result = spawnSync(bin, [join(root, entry)], {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
  });
  return `${result.stdout}\n${result.stderr}`;
}

describe("tsx boot resolution (start.mjs spawn contract)", () => {
  for (const { pkg, entry } of ENTRYPOINTS) {
    it(`${entry} loads under the ${pkg} tsx bin without module-resolution errors`, () => {
      expect(boot(pkg, entry)).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    }, 90_000);
  }

  // The SDK is imported only once a DSN is set, from @millionsend/core's
  // directory: resolve it the way production does. Nothing listens on the
  // DSN's port, so the boot failure it reports goes nowhere.
  for (const { pkg, entry } of ENTRYPOINTS.slice(0, 2)) {
    it(`${entry} loads the error-tracking SDK when SENTRY_DSN is set`, () => {
      expect(boot(pkg, entry, { SENTRY_DSN: "http://key@127.0.0.1:9/1" })).not.toMatch(
        /ERR_MODULE_NOT_FOUND|Cannot find module/,
      );
    }, 90_000);
  }
});
