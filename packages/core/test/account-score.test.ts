import { describe, expect, it } from "vitest";
import type { AccountScoreInput } from "../src/account-score.js";
import {
  computeAccountScore,
  contentFactorImpact,
  MIN_OUTCOME_SENDS,
} from "../src/account-score.js";

function input(overrides: Partial<AccountScoreInput>): AccountScoreInput {
  return {
    contentWeightedTenths: 0,
    contentRecipients: 0,
    sent: 0,
    complained: 0,
    hardBounced: 0,
    guardrailStatus: "ok",
    ...overrides,
  };
}

describe("computeAccountScore", () => {
  it("returns null score and band with no data at all", () => {
    const s = computeAccountScore(input({}));
    expect(s.scoreTenths).toBeNull();
    expect(s.band).toBeNull();
    expect(s.contentScoreTenths).toBeNull();
    expect(s.outcomeScoreTenths).toBeNull();
    expect(s.insufficientOutcomeData).toBe(true);
  });

  it("falls back to the content sub-score below the outcome volume floor", () => {
    const s = computeAccountScore(
      input({
        contentWeightedTenths: 79 * 50,
        contentRecipients: 50,
        sent: MIN_OUTCOME_SENDS - 1,
      }),
    );
    expect(s.outcomeScoreTenths).toBeNull();
    expect(s.insufficientOutcomeData).toBe(true);
    expect(s.scoreTenths).toBe(79);
    expect(s.band).toBe("good");
  });

  it("blends 0.4·C + 0.6·O for a clean high-volume sender", () => {
    const s = computeAccountScore(
      input({ contentWeightedTenths: 95 * 10_000, contentRecipients: 10_000, sent: 10_000 }),
    );
    expect(s.outcomeScoreTenths).toBe(100);
    expect(s.contentScoreTenths).toBe(95);
    expect(s.scoreTenths).toBe(98);
    expect(s.band).toBe("excellent");
  });

  it("uses the outcome sub-score alone when no emails are scored yet", () => {
    const s = computeAccountScore(input({ sent: 10_000 }));
    expect(s.contentScoreTenths).toBeNull();
    expect(s.scoreTenths).toBe(100);
  });

  it("ramps the complaint penalty across Google's 0.1%–0.3% lines", () => {
    // 0.2% sits midway through the 0→6pt ramp.
    const s = computeAccountScore(input({ sent: 10_000, complained: 20 }));
    expect(s.complaintRate).toBeCloseTo(0.002);
    expect(s.outcomeScoreTenths).toBe(70);
  });

  it("ramps the hard-bounce penalty from 2%", () => {
    const s = computeAccountScore(input({ sent: 10_000, hardBounced: 300 }));
    expect(s.hardBounceRate).toBeCloseTo(0.03);
    expect(s.outcomeScoreTenths).toBe(87);
  });

  it("the governor keeps perfect content from masking bad outcomes", () => {
    const s = computeAccountScore(
      input({
        contentWeightedTenths: 100 * 10_000,
        contentRecipients: 10_000,
        sent: 10_000,
        complained: 32,
      }),
    );
    expect(s.outcomeScoreTenths).toBe(39);
    // blend would be 63; governor caps at O + 1.5
    expect(s.scoreTenths).toBe(54);
    expect(s.band).toBe("needs_attention");
  });

  it("guardrail standing caps the headline so score and pause can't contradict", () => {
    const clean = input({
      contentWeightedTenths: 95 * 10_000,
      contentRecipients: 10_000,
      sent: 10_000,
    });
    expect(computeAccountScore({ ...clean, guardrailStatus: "warning" }).scoreTenths).toBe(69);
    const paused = computeAccountScore({ ...clean, guardrailStatus: "paused" });
    expect(paused.scoreTenths).toBe(49);
    expect(paused.band).toBe("at_risk");
  });

  it("zero sends yields zero rates, never NaN", () => {
    const s = computeAccountScore(input({ complained: 5, hardBounced: 5 }));
    expect(s.complaintRate).toBe(0);
    expect(s.hardBounceRate).toBe(0);
  });
});

describe("contentFactorImpact", () => {
  it("prices a failing check by its recipient-weighted penalty and the lift fixing it alone gives", () => {
    // 1,000 recipients at 9.0 content: a 1.0-point check (100 hundredths)
    // failing on all of them costs the whole gap to 10.0.
    const input = {
      contentWeightedTenths: 90 * 1000,
      contentRecipients: 1000,
      sent: 1000,
      complained: 0,
      hardBounced: 0,
      guardrailStatus: "ok" as const,
    };
    const impact = contentFactorImpact(input, { weightedPenaltyHundredths: 100 * 1000 });
    expect(impact.penaltyTenths).toBeCloseTo(10);
    // headline 0.4·90 + 0.6·100 = 96 → 0.4·100 + 0.6·100 = 100
    expect(impact.liftTenths).toBe(4);
    expect(computeAccountScore(input)).toMatchObject({
      blendTenths: 96,
      governorCapTenths: 115,
      guardrailCapTenths: null,
    });
  });

  it("gives no lift while the guardrail holds the headline down", () => {
    const input = {
      contentWeightedTenths: 80 * 100,
      contentRecipients: 100,
      sent: 1000,
      complained: 0,
      hardBounced: 0,
      guardrailStatus: "paused" as const,
    };
    expect(contentFactorImpact(input, { weightedPenaltyHundredths: 100 * 100 }).liftTenths).toBe(0);
    expect(computeAccountScore(input).guardrailCapTenths).toBe(49);
  });
});
