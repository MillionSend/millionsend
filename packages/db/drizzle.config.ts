import { defineConfig } from "drizzle-kit";

// `generate` is offline; `migrate` must fail loudly rather than guess a URL —
// a missing DATABASE_URL in CI once meant "migrated the runner's localhost".
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {}),
  strict: true,
  verbose: true,
});
