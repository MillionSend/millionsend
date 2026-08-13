import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      // Tests construct partial environments; boot-time validation is
      // exercised explicitly in config's own tests, not implicitly here.
      SKIP_ENV_VALIDATION: "1",
    },
  },
});
