import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // Only needed for `drizzle-kit migrate`; `generate` is offline.
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/millionsend",
  },
  strict: true,
  verbose: true,
});
