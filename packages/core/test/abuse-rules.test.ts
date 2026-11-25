import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { composeJudgeVerdict, raiseImageLure } from "../src/abuse-judge/questions.js";
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

/** Arbitrary image questions and numbers, only for the schema and the composer: no real detection wording. */
const FAKE_VISION = {
  prompt: DEFAULT_ABUSE_RULES.judge.vision.prompt,
  questions: {
    shows_teapot: { type: "noul" as const, instructions: "Does `images` show a teapot?" },
    shows_kettle: { type: "noul" as const, instructions: "Does `images` show a kettle?" },
  },
  holdKeys: ["shows_teapot"],
  limit: 0.5,
  category: "scam",
};

function withFakeVision(rules: AbuseRules): void {
  rules.judge.vision = structuredClone(FAKE_VISION);
  rules.keys.holdReasons = [...rules.keys.holdReasons, "image_lure"];
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

  it("refuses rules without the keys the worker reads by name", () => {
    const message = errorOf(
      rulesWith((r) => {
        delete r.judge.inbound.questions.concealed;
        r.judge.inbound.reasonKeys = r.judge.inbound.reasonKeys.filter((k) => k !== "concealed");
        const criteria = r.judge.outbound.questions.category?.criteria ?? {};
        delete criteria.clean;
        delete criteria.payment_redirect;
        r.keys.holdCategories = r.keys.holdCategories.filter((k) => k !== "payment_redirect");
        r.keys.platformLinkCategories = r.keys.platformLinkCategories.filter(
          (k) => k !== "payment_redirect",
        );
        r.keys.loopbackLinkCategories = r.keys.loopbackLinkCategories.filter(
          (k) => k !== "payment_redirect",
        );
      }),
    );
    for (const path of [
      "judge.inbound.questions.concealed",
      "judge.inbound.reasonKeys",
      "judge.outbound.questions.category.criteria.clean",
      "judge.outbound.questions.category.criteria.payment_redirect",
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

  it("accepts image questions, and the image reason as a hold reason only beside them", () => {
    expect(parseAbuseRules(rulesWith(withFakeVision)).judge.vision).toEqual(FAKE_VISION);
    expect(
      errorOf(
        rulesWith((r) => {
          r.keys.holdReasons = [...r.keys.holdReasons, "image_lure"];
        }),
      ),
    ).toContain(`keys.holdReasons.${DEFAULT_ABUSE_RULES.keys.holdReasons.length}`);
  });

  it("checks image questions against the outbound set", () => {
    const message = errorOf(
      rulesWith((r) => {
        withFakeVision(r);
        r.judge.vision.holdKeys = ["shows_teapot", "no_such_image_key"];
        r.judge.vision.category = "no_such_category";
        r.judge.outbound.questions.image__shows_kettle = { type: "noul", instructions: "x" };
      }),
    );
    for (const path of [
      "judge.vision.holdKeys.1",
      "judge.vision.category: not a known key",
      "judge.vision.questions.shows_kettle: collides",
    ]) {
      expect(message).toContain(path);
    }
    const unset = errorOf(
      rulesWith((r) => {
        withFakeVision(r);
        delete r.judge.vision.limit;
        delete r.judge.vision.category;
      }),
    );
    expect(unset).toContain("judge.vision.limit: required with questions");
    expect(unset).toContain("judge.vision.category: required with questions");
    const cannotHold = errorOf(
      rulesWith((r) => {
        withFakeVision(r);
        r.judge.vision.holdKeys = [];
        r.judge.vision.limit = 0;
        r.keys.holdReasons = DEFAULT_ABUSE_RULES.keys.holdReasons;
      }),
    );
    for (const path of [
      "judge.vision.holdKeys: must not be empty",
      "judge.vision.limit: must be above 0",
      "keys.holdReasons: must include image_lure",
    ]) {
      expect(cannotHold).toContain(path);
    }
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

  it("files a held image answer as an image lure, raised to the hold score", () => {
    setAbuseRulesForTests(rulesWith(withFakeVision));
    const answers = {
      is_abuse: { noul: 0.1 },
      category: { choice: "clean" },
      image__shows_teapot: { noul: 0.9 },
      image__shows_kettle: { noul: 0.6 },
    };
    const verdict = composeJudgeVerdict(answers, { images: true });
    expect(verdict).toMatchObject({
      verdict: "clean",
      score: 10,
      categories: ["scam"],
      reasons: ["image__shows_teapot", "image__shows_kettle", "image_lure"],
    });
    expect(raiseImageLure(verdict, 90)).toMatchObject({ verdict: "abuse", score: 90 });
    // Image answers on a call that sent no images, or under the limit, are no finding.
    expect(composeJudgeVerdict(answers).reasons).toEqual([]);
    const under = composeJudgeVerdict(
      { ...answers, image__shows_teapot: { noul: 0.4 } },
      { images: true },
    );
    expect(under).toMatchObject({ categories: [], reasons: ["image__shows_kettle"] });
    expect(raiseImageLure(under, 90)).toBe(under);
  });
});
