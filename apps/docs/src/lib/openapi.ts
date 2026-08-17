import { createOpenAPI } from "fumadocs-openapi/server";

// The path doubles as the schema id embedded in generated MDX (`document`
// prop), so scripts/generate-openapi.ts must import this same instance and
// every command must run with cwd = apps/docs (pnpm --filter guarantees it).
export const openapi = createOpenAPI({
  input: ["./public/openapi.json"],
});
