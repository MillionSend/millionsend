import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { countUp, createProgress } from "../src/progress.js";
import { formatDuration, formatNumber } from "../src/utils.js";

function sink() {
  const chunks: string[] = [];
  const stream = {
    write: (c: string) => {
      chunks.push(String(c));
      return true;
    },
  } as never;
  return { chunks, stream };
}

describe("createProgress (piped)", () => {
  it("appends a line every 1,000 units and on done", () => {
    const { chunks, stream } = sink();
    const step = createProgress({ stream, tty: false }).step("Contacts");
    step.update(400, 12847);
    step.update(999, 12847);
    step.update(1000, 12847);
    step.update(1500, 12847);
    step.update(3200, 12847);
    step.note("2 rejected by the API");
    step.done();
    step.done("again");
    expect(chunks).toEqual([
      "⟳ Contacts 1,000/12,847\n",
      "⟳ Contacts 3,200/12,847\n",
      "! 2 rejected by the API\n",
      "✓ Contacts 3,200/12,847\n",
    ]);
  });

  it("fail and a summary on done", () => {
    const { chunks, stream } = sink();
    const progress = createProgress({ stream, tty: false });
    progress.step("Domains").done("3 created, 1 unchanged");
    progress.step("Webhooks").fail("MillionSend answered 500");
    expect(chunks).toEqual([
      "✓ Domains 3 created, 1 unchanged\n",
      "✗ Webhooks — MillionSend answered 500\n",
    ]);
  });
});

describe("createProgress (tty)", () => {
  it("rewrites the live line in place and keeps notes above it", () => {
    const { chunks, stream } = sink();
    const step = createProgress({ stream, tty: true }).step("Contacts");
    step.update(3200, 12847);
    step.note("resumed");
    step.done();
    expect(chunks.join("")).toBe(
      "\r\x1b[2K⟳ Contacts" +
        "\r\x1b[2K⟳ Contacts 3,200/12,847" +
        "\r\x1b[2K! resumed\n⟳ Contacts 3,200/12,847" +
        "\r\x1b[2K✓ Contacts 3,200/12,847\n",
    );
  });

  it("writeAbove clears the live line, writes to the other stream, redraws", () => {
    const bytes: string[] = [];
    const tag = (name: string) => ({
      write: (c: string) => {
        bytes.push(`${name}:${String(c)}`);
        return true;
      },
    });
    const progress = createProgress({ stream: tag("out") as never, tty: true });
    const step = progress.step("Contacts");
    step.update(3200, 12847);
    progress.writeAbove("warning: retry 2/5 in 1s — Resend 503\n", tag("err"));
    progress.clear();
    progress.writeAbove("error: Resend rejected the API key (401)\n", tag("err"));
    expect(bytes).toEqual([
      "out:\r\x1b[2K⟳ Contacts",
      "out:\r\x1b[2K⟳ Contacts 3,200/12,847",
      "out:\r\x1b[2K",
      "err:warning: retry 2/5 in 1s — Resend 503\n",
      "out:⟳ Contacts 3,200/12,847",
      "out:\r\x1b[2K",
      "err:error: Resend rejected the API key (401)\n",
    ]);
  });

  it("createContext routes the logger through the live line only on a TTY", () => {
    const bytes: string[] = [];
    // readline needs a real stream for its output; tap the writes and fake isTTY.
    const tag = (name: string, isTTY: boolean) => {
      const stream = Object.assign(new PassThrough(), { isTTY });
      const write = stream.write.bind(stream);
      stream.write = ((c: string) => {
        bytes.push(`${name}:${String(c)}`);
        return write(c);
      }) as typeof stream.write;
      return stream;
    };
    const config = parseConfig(["migrate", "--from", "resend"], {}, true);
    const tty = createContext(config, {
      stdout: tag("out", true) as never,
      stderr: tag("err", false) as never,
      stdin: new PassThrough(),
    });
    tty.progress.step("Contacts").update(1);
    tty.log.warn("careful");
    tty.rl.close();
    expect(bytes).toEqual([
      "out:\r\x1b[2K⟳ Contacts",
      "out:\r\x1b[2K⟳ Contacts 1",
      "out:\r\x1b[2K",
      "err:warning: careful\n",
      "out:⟳ Contacts 1",
    ]);

    bytes.length = 0;
    const piped = createContext(config, {
      stdout: tag("out", false) as never,
      stderr: tag("err", false) as never,
      stdin: new PassThrough(),
    });
    piped.progress.step("Contacts").update(1);
    piped.log.warn("careful");
    piped.rl.close();
    expect(bytes).toEqual(["err:warning: careful\n"]);
  });
});

describe("countUp", () => {
  it("prints static right-aligned rows when piped", async () => {
    const { chunks, stream } = sink();
    await countUp(
      [
        { label: "contacts", value: 12847 },
        { label: "segments", value: 7 },
      ],
      { stream, tty: false },
    );
    expect(chunks).toEqual(["12,847  contacts\n     7  segments\n"]);
  });

  it("animates on a TTY and ends on the exact numbers", async () => {
    const { chunks, stream } = sink();
    await countUp([{ label: "contacts", value: 12847 }], { stream, tty: true, ms: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[chunks.length - 1]).toBe("12,847  contacts\n");
    expect(chunks[chunks.length - 2]).toBe("\x1b[1A");
  });
});

describe("format helpers", () => {
  it("thousands separators and durations", () => {
    expect(formatNumber(713)).toBe("713");
    expect(formatNumber(2140)).toBe("2,140");
    expect(formatDuration(12)).toBe("12 s");
    expect(formatDuration(0.2)).toBe("1 s");
    expect(formatDuration(267)).toBe("about 4 min");
  });
});
