import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const STATE_DIR = ".millionsend";

export interface MigratePaths {
  dir: string;
  state: string;
  reportJson: string;
  reportMd: string;
}

export function migratePaths(cwd = process.cwd()): MigratePaths {
  const dir = join(cwd, STATE_DIR);
  return {
    dir,
    state: join(dir, "migrate-state.json"),
    reportJson: join(dir, "migrate-report.json"),
    reportMd: join(dir, "migrate-report.md"),
  };
}

/**
 * Owner-only file (0600, directory 0700), written whole to a sibling and
 * renamed over the target so an interrupt never leaves a half-written state.
 * The sibling is created exclusively: the cwd may be a checkout the user did
 * not author, and a pre-planted symlink at `<file>.tmp` (or at .millionsend
 * itself) would otherwise be followed to wherever it points.
 */
export function writePrivate(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (basename(dir) === STATE_DIR && lstatSync(dir).isSymbolicLink()) {
    throw new Error(`${dir} is a symbolic link; remove it and run again.`);
  }
  const tmp = `${path}.tmp`;
  const options = { mode: 0o600, flag: "wx" } as const;
  try {
    writeFileSync(tmp, content, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    unlinkSync(tmp);
    writeFileSync(tmp, content, options);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function writePrivateJson(path: string, value: unknown): void {
  writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parsed JSON, or null when the file does not exist. */
export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`${path} is not valid JSON; delete it or pass --fresh to start over.`);
  }
}

/**
 * Appends `.millionsend/` to the .gitignore in `cwd` when one exists and does
 * not list it yet. True when a line was added — the caller says so once.
 */
export function ensureGitignored(cwd = process.cwd()): boolean {
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  const listed = content
    .split(/\r?\n/)
    .some((line) => line.trim().replace(/^\/|\/$/g, "") === STATE_DIR);
  if (listed) return false;
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${separator}${STATE_DIR}/\n`);
  return true;
}
