import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boot + real migrations per suite outlast the 10s default on 2-core CI runners.
    // 1000-row seeds in platform-breaker also blow the 5s test default when turbo
    // packs the core suite next to other PGlite files.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    env: {
      // Tests construct partial environments; boot-time validation is
      // exercised explicitly in config's own tests, not implicitly here.
      SKIP_ENV_VALIDATION: "1",
      // Fixtures send to reserved domains; recipient-domains tests turn it on.
      RECIPIENT_DOMAIN_CHECK: "off",
    },
  },
});
