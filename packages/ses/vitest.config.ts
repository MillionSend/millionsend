import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // @millionsend/core reaches @millionsend/config through @millionsend/db;
    // validation would demand a full production env at import.
    env: { SKIP_ENV_VALIDATION: "1" },
  },
});
