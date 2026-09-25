import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { IAMClient } from "@aws-sdk/client-iam";
import { GetAccountCommand, PutAccountPricingAttributesCommand } from "@aws-sdk/client-sesv2";
import { STSClient } from "@aws-sdk/client-sts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlow } from "../../cli/src/flow.js";
import { setColorMode } from "../../cli/src/theme.js";
import { lineReader } from "../../cli/src/tty-ui.js";
import { upsertEnv } from "../src/setup.js";
import {
  addRegionMain,
  authAction,
  essentialsPlanPrompt,
  main,
  menuLoop,
  type Wizard,
} from "../src/setup-cli.js";
import { detectDirState, envValue } from "../src/setup-flow.js";

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

describe("main add-region --dry-run", () => {
  afterEach(() => {
    setColorMode("auto");
    vi.restoreAllMocks();
  });

  it("prints the add-region plan for the named region without prompting or touching AWS", async () => {
    setColorMode("never");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    expect(await main(["add-region", "us-east-1", "--dry-run"])).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Plan:");
    expect(out).toContain("SNS topic millionsend-events in us-east-1");
    expect(out).toContain("us-east-1 appended to AWS_REGIONS");
    expect(out).toContain("nothing was created or written");
  });

  it("refuses a malformed region name", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["add-region", "US East", "--dry-run"])).toBe(1);
    expect(errors).toHaveBeenCalledWith("Not an AWS region name: US East");
  });

  it("exits 1 when the install's queue URL is unusable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-setup-"));
    writeFileSync(
      join(dir, ".env"),
      "MASTER_ENCRYPTION_KEY=k\nBETTER_AUTH_SECRET=s\nSQS_QUEUE_URL=not-a-queue\nSNS_TOPIC_ARNS=arn:x\n",
    );
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["add-region", "eu-west-1"])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "SQS_QUEUE_URL is not a standard queue URL",
    );
  });

  it("exits 0 when the named region is already served, without calling AWS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-setup-"));
    writeFileSync(
      join(dir, ".env"),
      "MASTER_ENCRYPTION_KEY=k\nBETTER_AUTH_SECRET=s\nAWS_REGIONS=us-east-1,sa-east-1\nSQS_QUEUE_URL=not-a-queue\n",
    );
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    expect(await main(["add-region", "us-east-1"])).toBe(0);
    expect(lines.join("\n")).toContain("us-east-1 is already served");
  });
});

describe("add-region with stdin piped", () => {
  const stdin = process.stdin as { isTTY?: boolean | undefined };
  const wasTty = stdin.isTTY;
  afterEach(() => {
    stdin.isTTY = wasTty;
    vi.restoreAllMocks();
  });

  /** An install serving sa-east-1, AWS stubbed: STS answers, IAM (the first write) fails loudly. */
  function install(answers: string) {
    stdin.isTTY = false;
    const dir = mkdtempSync(join(tmpdir(), "ms-setup-"));
    writeFileSync(
      join(dir, ".env"),
      [
        "MASTER_ENCRYPTION_KEY=k",
        "BETTER_AUTH_SECRET=s",
        "AWS_REGIONS=sa-east-1",
        "SQS_QUEUE_URL=https://sqs.sa-east-1.amazonaws.com/123456789012/millionsend-events",
        "SNS_TOPIC_ARNS=arn:aws:sns:sa-east-1:123456789012:millionsend-events",
        "",
      ].join("\n"),
    );
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sts = vi.spyOn(STSClient.prototype, "send").mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/admin",
    } as never);
    const iam = vi.spyOn(IAMClient.prototype, "send").mockRejectedValue(new Error("stubbed IAM"));
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(answers);
    const rl = lineReader(input, output);
    return { flow: createFlow(rl, { rail: false }), rl, errors, sts, iam };
  }

  it.each([
    ["an empty answer", "\n"],
    ["EOF", ""],
  ])("provisions nothing when Proceed gets %s", async (_, answers) => {
    const { flow, rl, iam } = install(answers);
    expect(await addRegionMain(flow, ["eu-west-1"], false)).toBe(1);
    expect(iam).not.toHaveBeenCalled();
    rl.close();
  });

  it("proceeds on an explicit yes", async () => {
    const { flow, rl, errors, iam } = install("y\n");
    expect(await addRegionMain(flow, ["eu-west-1"], false)).toBe(1);
    expect(iam).toHaveBeenCalled();
    expect(errors.mock.calls.flat().join("\n")).toContain("Adding the region failed: stubbed IAM");
    rl.close();
  });

  it("refuses to pick a region itself", async () => {
    const { flow, rl, errors, sts } = install("eu-west-1\ny\n");
    expect(await addRegionMain(flow, [], false)).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "No region given, and stdin is not a terminal to choose one on: run add-region <region>",
    );
    expect(sts).not.toHaveBeenCalled();
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

describe("essentialsPlanPrompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeSes(plan: string | null | Error) {
    const calls: object[] = [];
    return {
      calls,
      ses: {
        send: async (command: object) => {
          calls.push(command);
          if (plan instanceof Error) throw plan;
          return command instanceof GetAccountCommand
            ? { PricingAttributes: { CurrentPlan: plan ?? undefined } }
            : {};
        },
      },
    };
  }
  const answering = (answer: string) =>
    createFlow({ question: async () => answer }, { rail: false });

  it("cancels only on an explicit yes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const yes = fakeSes("ESSENTIALS");
    expect(await essentialsPlanPrompt(answering("y"), yes.ses, "us-east-1")).toBe("cancelled");
    const cancel = yes.calls.find((c) => c instanceof PutAccountPricingAttributesCommand);
    expect(cancel).toMatchObject({ input: { Plan: "NONE" } });

    for (const answer of ["", "n", "maybe"]) {
      const kept = fakeSes("ESSENTIALS");
      expect(await essentialsPlanPrompt(answering(answer), kept.ses, "us-east-1")).toBe("kept");
      expect(kept.calls.some((c) => c instanceof PutAccountPricingAttributesCommand)).toBe(false);
    }
  });

  it("asks nothing on à la carte, and leaves an unreadable plan alone", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const question = vi.fn(async () => "y");
    const rl = createFlow({ question }, { rail: false });
    const none = fakeSes("NONE");
    expect(await essentialsPlanPrompt(rl, none.ses, "us-east-1")).toBe("not_essentials");
    const down = fakeSes(new Error("throttled"));
    expect(await essentialsPlanPrompt(rl, down.ses, "us-east-1")).toBe("unknown");
    expect(question).not.toHaveBeenCalled();
    expect(none.calls).toHaveLength(1);
  });
});

describe("menuLoop", () => {
  afterEach(() => {
    setColorMode("auto");
    vi.restoreAllMocks();
  });

  const env =
    "MASTER_ENCRYPTION_KEY=k\nBETTER_AUTH_SECRET=s\nAWS_ACCESS_KEY_ID=AKIA\nSNS_TOPIC_ARNS=arn:a\nSQS_QUEUE_URL=https://q\n";

  function stub(answers: string, opts: { cloud?: boolean; env?: string } = {}) {
    setColorMode("never");
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(answers);
    const rl = lineReader(input, output);
    const flow = createFlow(rl, { rail: false });
    const content = opts.env ?? env;
    const wizard: Wizard = {
      flow,
      interactive: false,
      cloud: opts.cloud ?? false,
      state: detectDirState((name) => (name === ".env" ? content : null), null),
      env: content,
      typedAppBaseUrl: null,
      writeEnv(entries) {
        if (wizard.env === null) return false;
        wizard.env = upsertEnv(wizard.env, entries);
        return true;
      },
      enableProfile: () => false,
      appBaseUrl: () =>
        wizard.typedAppBaseUrl || envValue(wizard.env, "APP_BASE_URL") || "http://localhost:3000",
      apiPort: () => 3001,
    };
    return { wizard, rl, output };
  }

  it("defaults to Exit so Enter does not provision AWS", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { wizard, rl } = stub("\n");
    expect(await menuLoop(wizard)).toBe(0);
    rl.close();
  });

  it("writes IS_CLOUD=true from --cloud even if the operator then exits", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { wizard, rl } = stub("\n", { cloud: true });
    expect(await menuLoop(wizard)).toBe(0);
    expect(envValue(wizard.env, "IS_CLOUD")).toBe("true");
    rl.close();
  });

  it("never prints the current Stripe secrets, and an empty answer keeps them", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    const stripeKey = ["sk", "live", "0123456789abcd"].join("_");
    const webhookSecret = ["whsec", "0123456789wxyz"].join("_");
    const secrets = `STRIPE_SECRET_KEY=${stripeKey}\nSTRIPE_WEBHOOK_SECRET=${webhookSecret}\n`;
    const { wizard, rl, output } = stub("cloud\n", { cloud: true, env: `${env}${secrets}` });
    expect(await menuLoop(wizard)).toBe(0);
    const shown = `${logged.join("\n")}${output.read()?.toString() ?? ""}`;
    expect(shown).toContain("STRIPE_SECRET_KEY: ");
    expect(shown).not.toContain("0123456789abcd");
    expect(shown).not.toContain("0123456789wxyz");
    expect(envValue(wizard.env, "STRIPE_SECRET_KEY")).toBe(stripeKey);
    expect(envValue(wizard.env, "STRIPE_WEBHOOK_SECRET")).toBe(webhookSecret);
    rl.close();
  });

  it("returns to the menu after a step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { wizard, rl } = stub("urls\nhttps://mail.example.com\n\n\n");
    expect(await menuLoop(wizard)).toBe(0);
    expect(wizard.typedAppBaseUrl).toBe("https://mail.example.com");
    expect(envValue(wizard.env, "APP_BASE_URL")).toBe("https://mail.example.com");
    rl.close();
  });
});
