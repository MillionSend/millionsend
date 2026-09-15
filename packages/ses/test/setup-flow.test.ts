import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { upsertEnv } from "../src/setup.js";
import { envTemplate } from "../src/setup-constants.js";
import {
  addRegionEnvEntries,
  composeUpArgs,
  confirmed,
  detectDirState,
  envValue,
  flowPlan,
  freshDatabaseEntries,
  fullRerunOffered,
  generateSecret,
  menuOptions,
  missingSecrets,
  secretLaterHint,
  servedRegionsInEnv,
  setupDone,
  stateSummary,
} from "../src/setup-flow.js";

const noFiles = (): string | null => null;

describe("detectDirState / stateSummary", () => {
  it("reports a fresh directory without docker", () => {
    const state = detectDirState(noFiles, () => null);
    expect(stateSummary(state)).toBe("no .env · no compose file · docker not found");
  });

  it("reports found files and the docker version", () => {
    const files: Record<string, string> = {
      ".env": "A=1\n",
      "compose.yaml": "services: {}\n",
    };
    const state = detectDirState(
      (name) => files[name] ?? null,
      () => "docker compose v2.32.4",
    );
    expect(stateSummary(state)).toBe("found .env · found compose.yaml · docker compose v2.32.4");
    expect(state.composeContent).toBe("services: {}\n");
  });

  it("marks docker unchecked when the probe is skipped (--dry-run spawns nothing)", () => {
    const state = detectDirState(noFiles, null);
    expect(state.dockerProbed).toBe(false);
    expect(stateSummary(state)).toContain("docker not checked");
  });
});

describe("envValue / missingSecrets", () => {
  it("returns the first value, tolerating export and spaces", () => {
    expect(envValue("  export A_B = hello \nA_B=later\n", "A_B")).toBe("hello");
    expect(envValue("A=1\n", "B")).toBeNull();
    expect(envValue(null, "A")).toBeNull();
  });

  it("reads back the quoted forms upsertEnv writes", () => {
    const content = upsertEnv("", { A: "Ops <ops@example.com>", B: 'it\'s "$money"' });
    expect(envValue(content, "A")).toBe("Ops <ops@example.com>");
    expect(envValue(content, "B")).toBe('it\'s "$money"');
  });

  it("treats empty and absent secret lines as missing", () => {
    expect(missingSecrets("MASTER_ENCRYPTION_KEY=\nOTHER=x\n")).toEqual([
      "MASTER_ENCRYPTION_KEY",
      "BETTER_AUTH_SECRET",
    ]);
    expect(missingSecrets("MASTER_ENCRYPTION_KEY=abc\nBETTER_AUTH_SECRET=def\n")).toEqual([]);
  });
});

describe("generateSecret", () => {
  it("emits base64 of 32 random bytes, the same shape as openssl rand -base64 32", () => {
    const secret = generateSecret();
    expect(Buffer.from(secret, "base64")).toHaveLength(32);
    expect(generateSecret()).not.toBe(secret);
  });
});

describe("freshDatabaseEntries", () => {
  it("puts one random URL-safe password in both POSTGRES_PASSWORD and DATABASE_URL", () => {
    const entries = freshDatabaseEntries();
    expect(entries.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(entries.DATABASE_URL).toBe(
      `postgres://millionsend:${entries.POSTGRES_PASSWORD}@postgres:5432/millionsend`,
    );
    expect(freshDatabaseEntries().POSTGRES_PASSWORD).not.toBe(entries.POSTGRES_PASSWORD);
  });
});

describe("secretLaterHint", () => {
  it("names the key and the openssl one-liner", () => {
    const hint = secretLaterHint("BETTER_AUTH_SECRET");
    expect(hint).toContain("BETTER_AUTH_SECRET");
    expect(hint).toContain("openssl rand -base64 32");
  });
});

describe("confirmed", () => {
  it("empty answer takes the caller's default — piped runs (default no) skip", () => {
    expect(confirmed("", false)).toBe(false);
    expect(confirmed("  ", false)).toBe(false);
    expect(confirmed("", true)).toBe(true);
  });

  it("accepts y/yes in any case, rejects everything else", () => {
    expect(confirmed("y", false)).toBe(true);
    expect(confirmed("YES", false)).toBe(true);
    expect(confirmed("n", true)).toBe(false);
    expect(confirmed("nope", true)).toBe(false);
  });
});

describe("composeUpArgs", () => {
  it("adds --build only for a compose file with a build key", () => {
    expect(composeUpArgs("services:\n  app:\n    build: .\n")).toEqual([
      "compose",
      "up",
      "--build",
      "-d",
    ]);
    expect(composeUpArgs("services:\n  app:\n    image: x\n")).toEqual(["compose", "up", "-d"]);
    expect(composeUpArgs(null)).toEqual(["compose", "up", "-d"]);
  });

  it("does not mistake keys merely ending in build for a build key", () => {
    expect(composeUpArgs("services:\n  app:\n    rebuild: .\n")).toEqual(["compose", "up", "-d"]);
  });
});

describe("flowPlan", () => {
  const opts = { appBaseUrl: "http://localhost:3000", region: "us-east-1" };

  it("plans everything for a fresh directory", () => {
    const plan = flowPlan(detectDirState(noFiles, null), opts).join("\n");
    expect(plan).toContain("create .env from the built-in template");
    expect(plan).toContain("generate MASTER_ENCRYPTION_KEY and BETTER_AUTH_SECRET");
    expect(plan).toContain("APP_BASE_URL prompt (default http://localhost:3000)");
    expect(plan).toContain("PUBLIC_API_URL prompt");
    expect(plan).toContain("aws: IAM user millionsend");
    expect(plan).toContain("delivering to SQS queue millionsend-events");
    expect(plan).toContain("download deploy/docker-compose.yml, then docker compose up -d");
  });

  it("keeps an existing .env with secrets set and honors the compose build key", () => {
    const files: Record<string, string> = {
      ".env": "MASTER_ENCRYPTION_KEY=a\nBETTER_AUTH_SECRET=b\n",
      "docker-compose.yml": "services:\n  app:\n    build: .\n",
    };
    const plan = flowPlan(
      detectDirState((name) => files[name] ?? null, null),
      { appBaseUrl: "https://mail.example.com", region: "eu-west-1" },
    ).join("\n");
    expect(plan).toContain("keep the existing .env");
    expect(plan).toContain("MASTER_ENCRYPTION_KEY and BETTER_AUTH_SECRET already set");
    expect(plan).toContain("aws: SNS topic millionsend-events in eu-west-1");
    expect(plan).toContain("docker compose up --build -d (docker-compose.yml)");
  });
});

// The template must be able to stand in for the repo's .env.example in an
// empty directory; in the published-package context the file is absent, so
// the pin is skipped rather than failed there.
const envExamplePath = fileURLToPath(new URL("../../../.env.example", import.meta.url));
describe("envTemplate", () => {
  it.skipIf(!existsSync(envExamplePath))("is byte-identical to the repo's .env.example", () => {
    expect(envTemplate()).toBe(readFileSync(envExamplePath, "utf8"));
  });
});

describe("addRegionEnvEntries / servedRegionsInEnv", () => {
  const topic = "arn:aws:sns:us-east-1:123456789012:millionsend-events";

  it("reads the served regions the way the app does", () => {
    expect(servedRegionsInEnv("AWS_REGIONS=sa-east-1, us-east-1\nAWS_REGION=sa-east-1\n")).toEqual([
      "sa-east-1",
      "us-east-1",
    ]);
    expect(servedRegionsInEnv("AWS_REGION=eu-west-1\n")).toEqual(["eu-west-1"]);
    expect(servedRegionsInEnv("AWS_REGIONS=\n")).toEqual(["us-east-1"]);
    expect(servedRegionsInEnv(null)).toEqual(["us-east-1"]);
  });

  it("seeds AWS_REGIONS from the region already served and appends the topic", () => {
    const content = "AWS_REGION=sa-east-1\nSNS_TOPIC_ARNS=arn:first\nSQS_QUEUE_URL=https://q\n";
    expect(addRegionEnvEntries(content, "us-east-1", topic)).toEqual({
      AWS_REGIONS: "sa-east-1,us-east-1",
      SNS_TOPIC_ARNS: `arn:first,${topic}`,
    });
    // Applied through upsertEnv the alias and the queue stay untouched.
    expect(upsertEnv(content, addRegionEnvEntries(content, "us-east-1", topic))).toBe(
      `AWS_REGION=sa-east-1\nSNS_TOPIC_ARNS=arn:first,${topic}\nSQS_QUEUE_URL=https://q\nAWS_REGIONS=sa-east-1,us-east-1\n`,
    );
  });

  it("extends an existing list without duplicating a region or a topic", () => {
    const content = `AWS_REGIONS=sa-east-1,us-east-1\nSNS_TOPIC_ARNS=arn:first,${topic}\n`;
    expect(addRegionEnvEntries(content, "us-east-1", topic)).toEqual({
      AWS_REGIONS: "sa-east-1,us-east-1",
      SNS_TOPIC_ARNS: `arn:first,${topic}`,
    });
    expect(addRegionEnvEntries(content, "eu-west-1", "arn:eu")).toEqual({
      AWS_REGIONS: "sa-east-1,us-east-1,eu-west-1",
      SNS_TOPIC_ARNS: `arn:first,${topic},arn:eu`,
    });
  });
});

describe("flowPlan on a finished install", () => {
  it("names the menu first, then the steps a piped run walks", () => {
    const envContent =
      "MASTER_ENCRYPTION_KEY=k\nBETTER_AUTH_SECRET=s\nAWS_ACCESS_KEY_ID=AKIA\nSNS_TOPIC_ARNS=arn:a\nSQS_QUEUE_URL=https://q\n";
    const state = detectDirState((name) => (name === ".env" ? envContent : null), null);
    const plan = flowPlan(state, { appBaseUrl: "http://x", region: "us-east-1" });
    expect(plan[0]).toContain("menu: this install is set up");
    expect(plan.join("\n")).toContain("aws: already set up");
  });
});

describe("fullRerunOffered", () => {
  it("is offered on a single-region install only", () => {
    expect(fullRerunOffered("AWS_REGION=sa-east-1\n")).toBe(true);
    expect(fullRerunOffered(null)).toBe(true);
    expect(fullRerunOffered("AWS_REGIONS=sa-east-1,us-east-1\n")).toBe(false);
  });
});

describe("setupDone / menuOptions", () => {
  const secrets = "MASTER_ENCRYPTION_KEY=k\nBETTER_AUTH_SECRET=s\n";

  it("counts an install as done once its secrets and some AWS are in place", () => {
    expect(setupDone(null)).toBe(false);
    expect(setupDone(secrets)).toBe(false);
    expect(setupDone(`${secrets}AWS_ACCESS_KEY_ID=AKIA\n`)).toBe(true);
    expect(setupDone(`${secrets}SNS_TOPIC_ARNS=arn:x\n`)).toBe(true);
    expect(setupDone("AWS_ACCESS_KEY_ID=AKIA\n")).toBe(false);
  });

  it("offers Add an SES region only with events and a queue, and cloud values only on cloud", () => {
    const values = (content: string, cloud = false) =>
      menuOptions(content, cloud).map((o) => o.value);
    expect(values(`${secrets}AWS_ACCESS_KEY_ID=AKIA\n`)).toEqual([
      "aws",
      "urls",
      "storage",
      "social",
      "email",
      "all",
      "start",
      "exit",
    ]);
    const full = `${secrets}AWS_REGIONS=sa-east-1,us-east-1\nSNS_TOPIC_ARNS=arn:a,arn:b\nSQS_QUEUE_URL=https://q\n`;
    expect(values(full, true)).toEqual([
      "region",
      "aws",
      "urls",
      "cloud",
      "storage",
      "social",
      "email",
      "all",
      "start",
      "exit",
    ]);
    expect(menuOptions(full, false)[0]?.hint).toBe("served: sa-east-1, us-east-1");
    expect(menuOptions(`${secrets}AWS_ACCESS_KEY_ID=AKIA\n`, false)[0]?.hint).toContain(
      "event ingestion",
    );
  });
});
