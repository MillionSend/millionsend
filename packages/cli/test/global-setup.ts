import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** One build before any test file: the subprocess tests all run the same dist/index.js. */
export async function setup(): Promise<void> {
  await promisify(execFile)("pnpm", ["build"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
}
