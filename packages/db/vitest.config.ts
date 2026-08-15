import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boot + real migrations per suite outlast the 10s default on 2-core CI runners.
    // testTimeout too: migrate.test.ts runs migrations inside the test body, not a hook.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
  },
});
