import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Page/component tests import .tsx; Next compiles with the automatic runtime.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // PGlite boot + real migrations per suite outlast the 10s default on 2-core CI runners.
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    env: { SKIP_ENV_VALIDATION: "1" },
  },
});
