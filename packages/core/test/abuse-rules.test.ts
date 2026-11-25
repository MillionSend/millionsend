import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { composeJudgeVerdict } from "../src/abuse-judge/questions.js";
import {
  type AbuseRules,
  abuseRules,
  abuseRulesInfo,
  DEFAULT_ABUSE_RULES,
  loadAbuseRulesFile,
  parseAbuseRules,
  setAbuseRulesForTests,
} from "../src/abuse-rules.js";
import { imitatedBrandIn } from "../src/imitated-brands.js";

const dir = mkdtempSync(join(tmpdir(), "abuse-rules-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setAbuseRulesForTests());

/** A deep copy of the built-in rules, changed by `edit`. */
function rulesWith(edit: (rules: AbuseRules) => void): AbuseRules {
  const rules = structuredClone(DEFAULT_ABUSE_RULES) as AbuseRules;
  edit(rules);
  return rules;
}

function errorOf(json: unknown): string {
  try {
    parseAbuseRules(json);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("parsed");
}

describe("parseAbuseRules", () => {
  it("accepts the built-in rules, also after a JSON round trip", () => {
    expect(parseAbuseRules(DEFAULT_ABUSE_RULES)).toEqual(DEFAULT_ABUSE_RULES);
    expect(parseAbuseRules(JSON.parse(JSON.stringify(DEFAULT_ABUSE_RULES)))).toEqual(
      DEFAULT_ABUSE_RULES,
    );
  });

  it("refuses keys that point at nothing, by path and never by value", () => {
    const message = errorOf(
      rulesWith((r) => {
        r.keys.holdCategories = ["phishing_credentials", "secret_category_x"];
        r.keys.holdReasons = ["secret_reason_y"];
        r.judge.outbound.reasonKeys = ["impersonation", "category", "no_such_question"];
        r.keys.anomalyChecks = ["no_such_check"];
        r.keys.mediaParksNew = ["no_such_issue"];
      }),
    );
    for (const path of [
      "keys.holdCategories.1",
      "keys.holdReasons.0",
      "judge.outbound.reasonKeys.1",
      "judge.outbound.reasonKeys.2",
      "keys.anomalyChecks.0",
      "keys.mediaParksNew.0",
    ]) {
      expect(message).toContain(path);
    }
    expect(message).not.toMatch(/secret_|no_such/);
  });

  it("refuses a question set without the keys its composer reads", () => {
    const message = errorOf(
      rulesWith((r) => {
        delete r.judge.outbound.questions.is_abuse;
        r.judge.outbound.questions.category = { type: "noul", instructions: "x" };
        delete r.judge.inbound.questions.is_injection;
        r.judge.inbound.questions.language = { type: "choice", instructions: "x" };
        delete r.judge.names.questions.label;
        r.judge.names.questions.extra = { type: "noul", instructions: "x" };
      }),
    );
    for (const path of [
      "judge.outbound.questions.is_abuse",
      "judge.outbound.questions.category",
      "judge.inbound.questions.is_injection",
      "judge.inbound.questions.language.criteria",
      "judge.names.questions.label",
      "judge.names.questions.extra",
    ]) {
      expect(message).toContain(path);
    }
  });

  it("refuses unknown fields and out-of-range numbers", () => {
    const message = errorOf({
      ...rulesWith((r) => {
        r.limits.judge.verdictNoul = 1.5;
      }),
      extra: true,
    });
    expect(message).toContain("(root): unrecognized_keys");
    expect(message).toContain("limits.judge.verdictNoul: too_big");
  });

  it("refuses warm-up tiers out of order", () => {
    const message = errorOf(
      rulesWith((r) => {
        r.limits.warmup.tierDays = [7, 1, 30];
      }),
    );
    expect(message).toContain("limits.warmup.tierDays: must ascend");
  });
});

describe("loadAbuseRulesFile", () => {
  it("reads a rules file", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify({ ...DEFAULT_ABUSE_RULES, version: "test-2" }));
    expect(loadAbuseRulesFile(path).version).toBe("test-2");
  });

  it("names the path, never the contents, when the file is missing or not JSON", () => {
    const missing = join(dir, "missing.json");
    expect(() => loadAbuseRulesFile(missing)).toThrow(`${missing} cannot be read (ENOENT)`);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, '{"policy": "secret wording"');
    expect(() => loadAbuseRulesFile(broken)).toThrow(
      `abuse rules file ${broken} is not valid JSON`,
    );
    expect(() => loadAbuseRulesFile(broken)).not.toThrow(/secret/);
  });
});

describe("abuseRules", () => {
  it("runs the built-in rules when no file is set", () => {
    expect(abuseRules()).toBe(DEFAULT_ABUSE_RULES);
    expect(abuseRulesInfo()).toEqual({ version: "default", source: "default" });
  });

  it("is read at use time, so swapped rules reach the composers and the brand lists", () => {
    const answers = { is_abuse: { noul: 0.7 } };
    expect(composeJudgeVerdict(answers).verdict).toBe("abuse");
    expect(imitatedBrandIn("Example Bank Support")).toBeNull();
    setAbuseRulesForTests(
      rulesWith((r) => {
        r.version = "test-3";
        r.limits.judge.verdictNoul = 0.9;
        r.lists.imitatedBrands = ["Example Bank"];
      }),
    );
    expect(abuseRulesInfo()).toEqual({ version: "test-3", source: "file" });
    expect(composeJudgeVerdict(answers).verdict).toBe("clean");
    expect(imitatedBrandIn("Example Bank Support")).toBe("Example Bank");
    expect(imitatedBrandIn("PayPal")).toBeNull();
  });
});
