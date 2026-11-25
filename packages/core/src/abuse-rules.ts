import { readFileSync } from "node:fs";
import { abuseRulesFile } from "@millionsend/config";
import { z } from "zod";
import { MEDIA_ISSUES } from "./abuse-judge/media.js";
import { DEFAULT_ABUSE_RULES } from "./abuse-rules-defaults.js";
import { CHECK_IDS } from "./email-insights.js";

/**
 * The detection rules: the judge's policies and questions, the brand and
 * host lists, the verdict keys the hold policy acts on and the numbers of
 * the risk model, screening, fingerprints, warm-up and inbound scoring. An
 * operator may supply them as a JSON file (ABUSE_RULES_FILE) that replaces
 * the built-in ones whole; the code that reads them is the same either way.
 * The composers read fixed question keys (is_abuse, impersonation,
 * category, language; is_injection and its kin inbound; one per name
 * field), so a file must keep those and may change any wording, add
 * questions and move any number.
 */

const words = z.array(z.string().min(1));
const unit = z.number().min(0).max(1);
const count = z.number().int().min(0);
const score = z.number().min(0).max(100);

const question = z.strictObject({
  type: z.enum(["noul", "choice"]),
  instructions: z.string().min(1),
  criteria: z.record(z.string(), z.string()).optional(),
});

const questionSet = {
  version: z.string().min(1).max(64),
  policy: z.string().min(1),
  questions: z.record(z.string(), question),
};

const OUTBOUND_KEYS = { noul: ["is_abuse", "impersonation"], choice: ["category", "language"] };
const INBOUND_KEYS = {
  noul: [
    "is_injection",
    "targets_agent",
    "override",
    "exfiltration",
    "credential_lure",
    "is_phishing",
    "is_spam",
  ],
  choice: ["category", "language"],
};
/** One question per shared-name field (SharedNameReview's), each a noul. */
const NAME_FIELDS = ["username", "from_name", "label"];

export const abuseRulesSchema = z
  .strictObject({
    schema: z.literal(1),
    version: z.string().min(1).max(64),
    judge: z.strictObject({
      outbound: z.strictObject({
        ...questionSet,
        /** Joined to the policy only for mail that names this platform (judgePolicy). */
        providerException: z.string(),
        reasonKeys: words,
      }),
      inbound: z.strictObject({ ...questionSet, reasonKeys: words }),
      names: z.strictObject({
        policy: z.string().min(1),
        questions: z.record(z.string(), question),
      }),
      vision: z.strictObject({ prompt: z.string().min(1) }),
    }),
    lists: z.strictObject({
      imitatedBrands: words,
      imitatedBrandWords: words,
      imitatedBrandAffixes: words,
      platformHostParents: words,
      sharedContentHosts: words,
      /** Beside the public mailbox domains, which always count. */
      majorPlatformDomains: words,
      revocablePlatforms: words,
      roleWords: words,
      hostnameWords: words,
    }),
    keys: z.strictObject({
      holdCategories: words,
      holdReasons: words,
      platformLinkCategories: words,
      platformLinkReasons: words,
      loopbackLinkCategories: words,
      loopbackLinkReasons: words,
      anomalyChecks: words,
      mediaParksNew: words,
    }),
    limits: z.strictObject({
      judge: z.strictObject({
        verdictNoul: unit,
        impersonationNoul: unit,
        reasonNoul: unit,
        textMaxChars: z.number().int().min(500),
        plainTextSharedWords: unit,
      }),
      inbound: z.strictObject({ strongNoul: unit, reasonNoul: unit, suspiciousScore: score }),
      names: z.strictObject({ refuseNoul: unit }),
      monitor: z.strictObject({
        probationDays: count,
        trustedDays: count,
        trustedSends: count,
        trustedCleanDays: count,
        riskHalfLifeDays: z.number().positive(),
        priorWeight: z.number().min(0),
        priorNew: unit,
        priorSettled: unit,
        flaggedRateMultiplier: z.number().min(1),
        pauseVerdictScore: score,
        holdRepeatDays: count,
        youngDomainDays: count,
      }),
      screening: z.strictObject({
        outstandingMax: z.number().int().min(1),
        novelDestinationsMax: count,
        destinationScreensPerDay: count,
        pastCapCleanDays: count,
        destinationClearBelow: score,
        destinationsClearedMax: count,
        destinationProbationDays: count,
        destinationRevokeScore: score,
      }),
      fingerprints: z.strictObject({
        displayNameMinWords: z.number().int().min(1),
        displayNameMaxExtraWords: count,
        subjectMinWords: z.number().int().min(1),
        subjectMinSimilarity: unit,
        domainMinWords: z.number().int().min(1),
        domainMinCoverage: unit,
        domainMinWordLength: z.number().int().min(1),
        domainSameNameMinLength: z.number().int().min(1),
        textHashMinLetters: count,
      }),
      warmup: z.strictObject({
        /** One per warm-up cap setting (first day, week, month), ascending. */
        tierDays: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
        graduationSends: count,
        graduationMaxBounceRate: unit,
        graduationMaxComplaintRate: unit,
      }),
      received: z.strictObject({
        failAt: count,
        grayAt: count,
        hiddenTextChars: count,
        invisibleChars: count,
      }),
    }),
  })
  .superRefine((rules, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const sets = [
      ["outbound", rules.judge.outbound.questions, OUTBOUND_KEYS],
      ["inbound", rules.judge.inbound.questions, INBOUND_KEYS],
    ] as const;
    for (const [set, questions, required] of sets) {
      for (const [key, q] of Object.entries(questions)) {
        if (q.type === "choice" && Object.keys(q.criteria ?? {}).length === 0) {
          fail(["judge", set, "questions", key, "criteria"], "a choice needs its options");
        }
      }
      for (const type of ["noul", "choice"] as const) {
        for (const key of required[type]) {
          if (questions[key]?.type !== type) {
            fail(["judge", set, "questions", key], `must be a ${type} question`);
          }
        }
      }
    }
    const names = rules.judge.names.questions;
    for (const key of NAME_FIELDS) {
      if (names[key]?.type !== "noul") fail(["judge", "names", "questions", key], "must be a noul");
    }
    for (const key of Object.keys(names)) {
      if (!NAME_FIELDS.includes(key)) fail(["judge", "names", "questions", key], "unknown field");
    }
    const subset = (
      path: (string | number)[],
      values: readonly string[],
      of: readonly string[],
    ) => {
      values.forEach((value, i) => {
        if (!of.includes(value)) fail([...path, i], "not a known key");
      });
    };
    const reasonsOf = (set: "outbound" | "inbound") => {
      const { questions, reasonKeys } = rules.judge[set];
      const nouls = Object.keys(questions).filter((key) => questions[key]?.type === "noul");
      subset(["judge", set, "reasonKeys"], reasonKeys, nouls);
    };
    reasonsOf("outbound");
    reasonsOf("inbound");
    const categories = Object.keys(rules.judge.outbound.questions.category?.criteria ?? {}).filter(
      (c) => c !== "clean",
    );
    const reasons = rules.judge.outbound.reasonKeys;
    const k = rules.keys;
    subset(["keys", "holdCategories"], k.holdCategories, categories);
    subset(["keys", "platformLinkCategories"], k.platformLinkCategories, categories);
    subset(["keys", "loopbackLinkCategories"], k.loopbackLinkCategories, categories);
    subset(["keys", "holdReasons"], k.holdReasons, reasons);
    subset(["keys", "platformLinkReasons"], k.platformLinkReasons, reasons);
    subset(["keys", "loopbackLinkReasons"], k.loopbackLinkReasons, reasons);
    subset(["keys", "anomalyChecks"], k.anomalyChecks, CHECK_IDS);
    subset(["keys", "mediaParksNew"], k.mediaParksNew, MEDIA_ISSUES);
    const [day, week, month] = rules.limits.warmup.tierDays;
    if (!(day < week && week < month)) fail(["limits", "warmup", "tierDays"], "must ascend");
    if (rules.limits.received.grayAt > rules.limits.received.failAt) {
      fail(["limits", "received", "grayAt"], "must not exceed failAt");
    }
  });

export type AbuseRules = z.output<typeof abuseRulesSchema>;
export type AbuseRulesSource = "file" | "default";

export { DEFAULT_ABUSE_RULES };

/**
 * The rules in `json`, or an error naming `label` and each failing path.
 * Messages carry paths and the schema's own wording, never a value from the
 * file, so they are safe to log and to report.
 */
export function parseAbuseRules(json: unknown, label = "abuse rules"): AbuseRules {
  const parsed = abuseRulesSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return issue.code === "custom" ? `${at}: ${issue.message}` : `${at}: ${issue.code}`;
  });
  throw new Error(`${label} is invalid: ${issues.join("; ")}`);
}

/** The rules in the JSON file at `path`; errors name the path, never its contents. */
export function loadAbuseRulesFile(path: string): AbuseRules {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(`abuse rules file ${path} cannot be read (${code})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`abuse rules file ${path} is not valid JSON`);
  }
  return parseAbuseRules(json, `abuse rules file ${path}`);
}

let loaded: { rules: AbuseRules; source: AbuseRulesSource } | undefined;

function load(): { rules: AbuseRules; source: AbuseRulesSource } {
  if (!loaded) {
    const path = abuseRulesFile();
    loaded = path
      ? { rules: loadAbuseRulesFile(path), source: "file" }
      : { rules: DEFAULT_ABUSE_RULES, source: "default" };
  }
  return loaded;
}

/** The rules this process runs, read once: ABUSE_RULES_FILE's, or the built-in ones. */
export function abuseRules(): AbuseRules {
  return load().rules;
}

/** Which rules run, for a boot line or the console: the version and where it came from, never content. */
export function abuseRulesInfo(): { version: string; source: AbuseRulesSource } {
  const { rules, source } = load();
  return { version: rules.version, source };
}

/** Reads the rules, so a bad file fails boot instead of the first mail; the line to log. */
export function checkAbuseRulesAtBoot(): string {
  const { version, source } = abuseRulesInfo();
  return `abuse rules: ${version} (${source})`;
}

/**
 * A value built from the rules, rebuilt only when the rules object changes:
 * the Sets and precomputed maps the hot paths look values up in.
 */
export function fromAbuseRules<T>(build: (rules: AbuseRules) => T): () => T {
  let seen: AbuseRules | undefined;
  let value: T;
  return () => {
    const rules = abuseRules();
    if (rules !== seen) {
      value = build(rules);
      seen = rules;
    }
    return value;
  };
}

/** Tests swap the rules in, or with no argument go back to reading the env on next use. */
export function setAbuseRulesForTests(rules?: AbuseRules): void {
  loaded = rules ? { rules, source: "file" } : undefined;
}
