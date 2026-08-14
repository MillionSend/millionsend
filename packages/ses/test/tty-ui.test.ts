import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lineReader } from "../src/setup-cli.js";
import { bannerLines, selectPrompt } from "../src/tty-ui.js";

describe("bannerLines", () => {
  it("renders MILLIONSEND on one line, every row the same width, echo included ≤ 78", () => {
    const lines = bannerLines();
    // 4 art rows + 1 echo row.
    expect(lines).toHaveLength(5);
    expect(lines[0]?.length).toBe(48);
    expect(lines[0]?.length).toBeLessThanOrEqual(78);
    for (const line of lines) expect(line.length).toBe(48);
  });

  it("draws full-shade bodies with a light-shade echo", () => {
    const text = bannerLines().join("\n");
    expect(text).toContain("█");
    expect(text).toContain("░");
  });
});

describe("selectPrompt non-TTY fallback", () => {
  // vitest workers run piped, so process.stdin/stdout are not TTYs here and
  // selectPrompt must take the lineReader question path.
  const options = [
    { value: "us-east-1", label: "us-east-1" },
    { value: "eu-west-1", label: "eu-west-1" },
  ];

  function reader(pipedInput: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(pipedInput);
    return { rl: lineReader(input, output), output };
  }

  it("returns the typed line, even one outside the options", async () => {
    const { rl, output } = reader("ap-southeast-2\n");
    const value = await selectPrompt(rl, { label: "AWS region", options, initial: "us-east-1" });
    expect(value).toBe("ap-southeast-2");
    expect(output.read()?.toString()).toBe("AWS region [us-east-1]: ");
    rl.close();
  });

  it("returns the initial on an empty answer and on EOF", async () => {
    const { rl } = reader("\n");
    expect(await selectPrompt(rl, { label: "AWS region", options, initial: "sa-east-1" })).toBe(
      "sa-east-1",
    );
    expect(await selectPrompt(rl, { label: "AWS region", options, initial: "sa-east-1" })).toBe(
      "sa-east-1",
    );
    rl.close();
  });

  it("defaults to the first option value without an initial", async () => {
    const { rl } = reader("\n");
    expect(await selectPrompt(rl, { label: "AWS region", options })).toBe("us-east-1");
    rl.close();
  });
});
