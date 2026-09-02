import { afterEach, describe, expect, it, vi } from "vitest";
import { setColorMode } from "../../cli/src/theme.js";
import { authAction, main } from "../src/setup-cli.js";

describe("main --dry-run", () => {
  afterEach(() => {
    setColorMode("auto");
    vi.restoreAllMocks();
  });

  async function captured(): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    expect(await main(["--dry-run"])).toBe(0);
    return lines.join("\n");
  }

  it("prints plain bytes when color is off", async () => {
    setColorMode("never");
    const out = await captured();
    expect(out).toContain("\nPlan:\n");
    expect(out).not.toContain("\x1b");
  });

  it("bolds the section title when color is on", async () => {
    setColorMode("always");
    expect(await captured()).toContain("\x1b[1mPlan:\x1b[22m");
  });
});

describe("authAction", () => {
  it("proceeds when the identity check passed", () => {
    expect(authAction({ identityOk: true, hasAwsCli: false, isTTY: false })).toBe("proceed");
  });

  it("offers a login only on a TTY with the aws CLI present", () => {
    expect(authAction({ identityOk: false, hasAwsCli: true, isTTY: true })).toBe("offer-login");
  });

  it("hints and exits on pipes even with the aws CLI present", () => {
    expect(authAction({ identityOk: false, hasAwsCli: true, isTTY: false })).toBe("hint-exit");
  });

  it("hints and exits on a TTY without the aws CLI", () => {
    expect(authAction({ identityOk: false, hasAwsCli: false, isTTY: true })).toBe("hint-exit");
  });
});
