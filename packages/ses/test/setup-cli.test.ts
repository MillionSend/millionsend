import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { authAction, lineReader } from "../src/setup-cli.js";

function reader() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, rl: lineReader(input, output) };
}

describe("lineReader", () => {
  it("keeps answers piped in one burst, including lines arriving between questions", async () => {
    const { input, rl } = reader();
    input.end("first\nsecond\nthird\n");
    expect(await rl.question("q1? ")).toBe("first");
    // The burst delivered these while no question was pending — the
    // readline/promises API drops them; the queue must not.
    expect(await rl.question("q2? ")).toBe("second");
    expect(await rl.question("q3? ")).toBe("third");
    rl.close();
  });

  it("answers a question that is already waiting when the line arrives", async () => {
    const { input, rl } = reader();
    const pending = rl.question("q? ");
    input.write("typed\n");
    expect(await pending).toBe("typed");
    rl.close();
  });

  it("resolves pending and later questions with '' after EOF", async () => {
    const { input, rl } = reader();
    input.end("only\n");
    expect(await rl.question("q1? ")).toBe("only");
    expect(await rl.question("q2? ")).toBe("");
    expect(await rl.question("q3? ")).toBe("");
    rl.close();
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
