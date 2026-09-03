import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/log.js";
import { setColorMode } from "../src/theme.js";

describe("redact", () => {
  it("masks every key shape and Authorization values, leaves the rest", () => {
    expect(redact("key re_AbC123_xyz and ms_9f8e7d-6c and whsec_a1B2+c3/d4= here")).toBe(
      "key *** and *** and *** here",
    );
    expect(redact("Authorization: Bearer abc.def")).toBe("Authorization: ***");
    expect(redact('{"authorization":"Bearer tok"}')).toBe('{"authorization":"***"}');
    expect(redact("forms_data items_count params_x")).toBe("forms_data items_count params_x");
  });
});

describe("createLogger", () => {
  function capture(level: "info" | "debug") {
    const lines: string[] = [];
    const log = createLogger({
      level,
      stream: {
        write: (chunk: string) => {
          lines.push(String(chunk));
          return true;
        },
      } as never,
    });
    return { lines, log };
  }

  it("filters below the level and prefixes error/warning", () => {
    const { lines, log } = capture("info");
    log.error("boom");
    log.warn("careful");
    log.info("plain");
    log.debug("hidden");
    expect(lines).toEqual(["error: boom\n", "warning: careful\n", "plain\n"]);
  });

  it("redacts at every level, debug included", () => {
    const { lines, log } = capture("debug");
    log.debug("GET /x → 401 token re_123456789012");
    expect(lines).toEqual(["GET /x → 401 token ***\n"]);
  });

  it("strips terminal control sequences from source-controlled text", () => {
    const { lines, log } = capture("info");
    log.warn("topics/News\x1b]52;c;cHduZWQ=\x07\x1b[2J\x07: rejected");
    expect(lines).toEqual(["warning: topics/News: rejected\n"]);
    expect(lines.join("")).not.toContain("\x1b");
  });
});

describe("createLogger colors", () => {
  it("colors only the level prefix when color is on, never the message", () => {
    setColorMode("always");
    try {
      const lines: string[] = [];
      const log = createLogger({ stream: { write: (c: string) => lines.push(c) } });
      log.error("boom");
      log.warn("careful");
      expect(lines).toEqual([
        "\x1b[31merror:\x1b[39m boom\n",
        "\x1b[33mwarning:\x1b[39m careful\n",
      ]);
    } finally {
      setColorMode("auto");
    }
  });
});
