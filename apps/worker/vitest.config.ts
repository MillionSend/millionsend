import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boot + real migrations per suite outlast the 10s default on 2-core CI runners.
    hookTimeout: 60_000,
    // Media tests parse real PDFs and images on worker threads; with every
    // package's tests running at once they outlast the 5s default.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    env: { SKIP_ENV_VALIDATION: "1", RECIPIENT_DOMAIN_CHECK: "off" },
  },
});
