import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The e2e boots the real API on PGlite: its config package would demand a
    // full production env at import, and the boot outlasts the 10s default.
    hookTimeout: 60_000,
    env: { SKIP_ENV_VALIDATION: "1" },
    globalSetup: ["test/global-setup.ts"],
  },
});
