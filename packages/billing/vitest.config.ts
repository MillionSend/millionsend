import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boot + real migrations per suite outlast the 10s default on 2-core CI runners.
    hookTimeout: 60_000,
    // Any PGlite test can outlast the 5s default there when turbo runs every suite at once.
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    env: {
      // Tests construct partial environments; boot-time validation is
      // exercised explicitly in config's own tests, not implicitly here.
      SKIP_ENV_VALIDATION: "1",
    },
  },
});
