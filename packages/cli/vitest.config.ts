import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The e2e boots the real API on PGlite: its config package would demand a
    // full production env at import, and the boot outlasts the 10s default.
    hookTimeout: 60_000,
    // Many tests drive the real API on PGlite through the CLI's own rate
    // limiter (10 req/s to the target): a hundred writes is ten seconds
    // before a 2-core CI runner adds its share.
    testTimeout: 60_000,
    env: { SKIP_ENV_VALIDATION: "1" },
    globalSetup: ["test/global-setup.ts"],
  },
});
