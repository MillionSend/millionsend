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
  { pkg: "packages/db", entry: "packages/db/src/migrate.ts" },
];

describe("tsx boot resolution (start.mjs spawn contract)", () => {
  for (const { pkg, entry } of ENTRYPOINTS) {
    it(`${entry} loads under the ${pkg} tsx bin without module-resolution errors`, () => {
      const bin = join(root, pkg, "node_modules/.bin/tsx");
      expect(existsSync(bin), `${pkg} must depend on tsx (bin missing)`).toBe(true);

      const result = spawnSync(bin, [join(root, entry)], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    }, 90_000);
  }
});
