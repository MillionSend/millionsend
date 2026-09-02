import { describe, expect, it } from "vitest";
import { ConfigError, helpText, parseConfig } from "../src/config.js";
import { TRADEMARK_NOTICE } from "../src/meta.js";

const env = {
  RESEND_API_KEY: "re_x",
  MILLIONSEND_API_KEY: "ms_y",
  MILLIONSEND_BASE_URL: "https://api.example.com/",
};

describe("parseConfig", () => {
  it("resolves the interactive default command with env-provided credentials", () => {
    const config = parseConfig(["migrate", "--from", "resend"], env, true);
    expect(config).toMatchObject({
      command: "migrate",
      from: "resend",
      fromKey: { source: "env", value: "re_x" },
      toKey: { source: "env", value: "ms_y" },
      toUrl: "https://api.example.com",
      rps: 8,
      onConflict: "upsert",
      nonInteractive: false,
      skip: [],
      only: null,
      warnings: [],
    });
  });

  it("parses subcommands, the plan file and every flag", () => {
    const config = parseConfig(
      [
        "migrate",
        "apply",
        "plan.json",
        "--yes",
        "--rps",
        "3",
        "--skip",
        "enrichment,api-keys",
        "--only",
        "contacts",
        "--on-conflict",
        "skip",
        "--json",
        "--verbose",
        "--no-color",
        "--fresh-webhook-secrets",
        "--include-sent",
        "--fresh",
        "--report",
        "out.md",
      ],
      env,
      true,
    );
    expect(config).toMatchObject({
      command: "apply",
      planFile: "plan.json",
      from: null,
      yes: true,
      rps: 3,
      skip: ["enrichment", "api-keys"],
      only: ["contacts"],
      onConflict: "skip",
      json: true,
      nonInteractive: true,
      verbose: true,
      color: false,
      freshWebhookSecrets: true,
      includeSent: true,
      fresh: true,
      report: "out.md",
    });
  });

  it("help and version short-circuit; no command means help", () => {
    expect(parseConfig(["--help"], {}, true).command).toBe("help");
    expect(parseConfig(["-V"], {}, true).command).toBe("version");
    expect(parseConfig([], {}, true).command).toBe("help");
  });

  it("stdin flags and command-line keys, with the process-list warning", () => {
    const config = parseConfig(
      [
        "migrate",
        "plan",
        "--from",
        "resend",
        "--from-key-stdin",
        "--to-key",
        "ms_k",
        "--to-url",
        "http://localhost:3001",
      ],
      {},
      false,
    );
    expect(config.fromKey).toEqual({ source: "stdin", value: null });
    expect(config.toKey).toEqual({ source: "flag", value: "ms_k" });
    expect(config.warnings).toEqual([
      "--to-key is visible to other users in process lists; prefer MILLIONSEND_API_KEY or --to-key-stdin.",
    ]);
  });

  it("status needs no credentials even when piped", () => {
    expect(parseConfig(["migrate", "status"], {}, false).command).toBe("status");
  });

  it.each([
    [["migrate"], "Missing --from <provider>"],
    [["migrate", "--from", "mailgun"], "Unknown provider `mailgun`. Supported: resend"],
    [["deploy"], "Unknown command `deploy`"],
    [["migrate", "sync"], "Unknown command `migrate sync`"],
    [["migrate", "plan", "x.json", "--from", "resend"], "Unexpected argument `x.json`"],
    [
      ["migrate", "--from", "resend", "--rps", "0"],
      "--rps must be a whole number between 1 and 10 (got 0)",
    ],
    [["migrate", "--from", "resend", "--rps", "2.5"], "--rps must be a whole number"],
    [
      ["migrate", "--from", "resend", "--skip", "foo"],
      "Unknown resource `foo` in --skip. Known: domains, properties",
    ],
    [
      ["migrate", "--from", "resend", "--on-conflict", "merge"],
      "--on-conflict must be upsert, skip or error",
    ],
    [["migrate", "--from", "resend", "--out", "p.json"], "--out only applies to `migrate plan`"],
    [["migrate", "--from", "resend", "--to-url", "nope"], "Not a URL: nope"],
    [
      ["migrate", "--from", "resend", "--from-key", "a", "--from-key-stdin"],
      "either --from-key or --from-key-stdin",
    ],
    [
      ["migrate", "--from", "resend", "--bogus"],
      "Unknown option '--bogus'. See millionsend --help",
    ],
  ])("%j → %s", (argv, message) => {
    expect(() => parseConfig(argv, env, true)).toThrow(ConfigError);
    expect(() => parseConfig(argv, env, true)).toThrow(message);
  });

  it("non-interactive runs name the missing env var or flag", () => {
    expect(() => parseConfig(["migrate", "--from", "resend"], {}, false)).toThrow(
      "Missing Resend API key. Set RESEND_API_KEY or pass --from-key-stdin",
    );
    expect(() =>
      parseConfig(["migrate", "--from", "resend"], { RESEND_API_KEY: "re_x" }, false),
    ).toThrow("Missing MillionSend API key. Set MILLIONSEND_API_KEY or pass --to-key-stdin");
    expect(() =>
      parseConfig(
        ["migrate", "--from", "resend"],
        { RESEND_API_KEY: "re_x", MILLIONSEND_API_KEY: "ms_y" },
        false,
      ),
    ).toThrow("Missing MillionSend API URL. Set MILLIONSEND_BASE_URL or pass --to-url <url>");
    expect(() => parseConfig(["migrate", "rollback"], {}, false)).toThrow(
      "Missing MillionSend API key",
    );
  });

  it("non-interactive migrate/apply/rollback need --yes up front; plan and status do not", () => {
    const message =
      "migrate/apply/rollback need --yes in non-interactive mode (or run `migrate plan` to only read).";
    for (const argv of [
      ["migrate", "--from", "resend"],
      ["migrate", "apply", "plan.json"],
      ["migrate", "rollback"],
      ["migrate", "--from", "resend", "--json"],
    ]) {
      expect(() => parseConfig(argv, env, false), argv.join(" ")).toThrow(ConfigError);
      expect(() => parseConfig(argv, env, false), argv.join(" ")).toThrow(message);
      expect(parseConfig([...argv, "--yes"], env, false).yes).toBe(true);
    }
    expect(parseConfig(["migrate", "plan", "--from", "resend"], env, false).command).toBe("plan");
    expect(parseConfig(["migrate", "status"], {}, false).command).toBe("status");
    expect(parseConfig(["migrate", "--from", "resend"], env, true).yes).toBe(false);
  });

  it("NO_COLOR in the environment turns color off", () => {
    expect(
      parseConfig(["migrate", "--from", "resend"], { ...env, NO_COLOR: "1" }, true).color,
    ).toBe(false);
  });
});

describe("helpText", () => {
  it("covers the grammar, every flag, env vars, exit codes and the trademark footer", () => {
    const text = helpText();
    for (const needle of [
      "migrate plan --from resend [--out plan.json]",
      "migrate apply [plan.json] [--yes]",
      "migrate rollback [--yes]",
      "--from-key-stdin",
      "--to-key-stdin",
      "--fresh-webhook-secrets",
      "--include-sent",
      "--on-conflict",
      "--fresh                    ignore resume progress; keeps what earlier runs created so rollback still works",
      "RESEND_API_KEY",
      "MILLIONSEND_API_KEY",
      "MILLIONSEND_BASE_URL",
      "DO_NOT_TRACK",
      "3 partial",
      TRADEMARK_NOTICE,
    ]) {
      expect(text).toContain(needle);
    }
    expect(text).not.toMatch(/!\s/);
  });
});
