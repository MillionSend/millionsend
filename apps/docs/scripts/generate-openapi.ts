import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ApiDeps, createApi } from "@millionsend/api";
import { generateFiles } from "fumadocs-openapi";
import { openapi } from "../src/lib/openapi";

/**
 * Extracts the API's OpenAPI document straight from the route definitions and
 * renders one MDX page per operation, so the reference can never drift from
 * the code.
 *
 * Importing @millionsend/api opens no connections (queue/db/keyring live in
 * its server entrypoint, src/server.ts), but it transitively imports
 * @millionsend/config, which validates env at import time — so this script
 * must run with SKIP_ENV_VALIDATION=1, the same escape hatch apps/web's build
 * uses. The deps below are never dereferenced: createApi only registers
 * routes, and serving /openapi.json executes no route handler.
 */
const inertDeps: ApiDeps = {
  db: null as unknown as ApiDeps["db"],
  keyring: null as unknown as ApiDeps["keyring"],
  isCloud: false,
  enqueueEmailSend: async () => {},
};

const app = createApi(inertDeps);
const res = await app.request("/openapi.json");
if (!res.ok) throw new Error(`GET /openapi.json failed: ${res.status}`);
const document = await res.json();

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
await mkdir(publicDir, { recursive: true });
await writeFile(`${publicDir}/openapi.json`, `${JSON.stringify(document, null, 2)}\n`);

// Regenerate from scratch so removed endpoints leave no stale pages. Paths are
// cwd-relative and must stay in sync with src/lib/openapi.ts (see note there).
const endpointsDir = fileURLToPath(
  new URL("../content/docs/api-reference/endpoints", import.meta.url),
);
await rm(endpointsDir, { recursive: true, force: true });
await generateFiles({
  input: openapi,
  output: "./content/docs/api-reference/endpoints",
  groupBy: "route",
  includeDescription: true,
});

console.log("generated public/openapi.json and content/docs/api-reference/endpoints");
