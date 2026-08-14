import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    env: { SKIP_ENV_VALIDATION: "1" },
  },
});
