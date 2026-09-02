import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitignored, migratePaths, readJson, writePrivateJson } from "../src/paths.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writePrivateJson / readJson", () => {
  it("creates .millionsend/ owner-only, writes 0600, leaves no temp file", () => {
    const paths = migratePaths(tempDir());
    writePrivateJson(paths.state, { version: 1 });
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.state).mode & 0o777).toBe(0o600);
    expect(existsSync(`${paths.state}.tmp`)).toBe(false);
    expect(readJson(paths.state)).toEqual({ version: 1 });
    expect(readJson(paths.reportJson)).toBeNull();
  });

  it("never follows a pre-planted symlink at <file>.tmp", () => {
    const cwd = tempDir();
    const paths = migratePaths(cwd);
    const elsewhere = join(cwd, "victim.txt");
    writeFileSync(elsewhere, "untouched");
    mkdirSync(paths.dir);
    symlinkSync(elsewhere, `${paths.state}.tmp`);
    writePrivateJson(paths.state, { version: 1 });
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
    expect(readJson(paths.state)).toEqual({ version: 1 });
    expect(existsSync(`${paths.state}.tmp`)).toBe(false);
    expect(lstatSync(paths.state).isSymbolicLink()).toBe(false);
  });

  it("refuses a .millionsend that is a symlink", () => {
    const cwd = tempDir();
    const paths = migratePaths(cwd);
    mkdirSync(join(cwd, "elsewhere"));
    symlinkSync(join(cwd, "elsewhere"), paths.dir);
    expect(() => writePrivateJson(paths.state, { version: 1 })).toThrow("symbolic link");
    expect(existsSync(join(cwd, "elsewhere", "migrate-state.json"))).toBe(false);
  });

  it("names the file and --fresh when the JSON is corrupt", () => {
    const paths = migratePaths(tempDir());
    mkdirSync(paths.dir);
    writeFileSync(paths.state, "{");
    expect(() => readJson(paths.state)).toThrow(
      `${paths.state} is not valid JSON; delete it or pass --fresh to start over.`,
    );
  });
});

describe("ensureGitignored", () => {
  it("appends once, only when a .gitignore exists", () => {
    const cwd = tempDir();
    expect(ensureGitignored(cwd)).toBe(false);
    writeFileSync(join(cwd, ".gitignore"), "node_modules");
    expect(ensureGitignored(cwd)).toBe(true);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n.millionsend/\n");
    expect(ensureGitignored(cwd)).toBe(false);
    writeFileSync(join(cwd, ".gitignore"), "/.millionsend\n");
    expect(ensureGitignored(cwd)).toBe(false);
  });
});
