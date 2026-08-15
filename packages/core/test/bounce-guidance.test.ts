import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOUNCE_GUIDANCE_KEYS,
  type BounceCategory,
  parseSmtpDiagnostic,
  resolveBounceGuidance,
  resolveComplaintGuidance,
} from "../src/bounce-guidance.js";

describe("parseSmtpDiagnostic", () => {
  it("extracts display and enhanced forms", () => {
    expect(parseSmtpDiagnostic("smtp; 550 5.1.1 user unknown")).toEqual({
      display: "550 5.1.1",
      enhanced: "5.1.1",
    });
    expect(parseSmtpDiagnostic("550-5.7.26 auth required")).toEqual({
      display: "550 5.7.26",
      enhanced: "5.7.26",
    });
  });
  it("returns nulls when there is no code", () => {
    expect(parseSmtpDiagnostic("mailbox unavailable")).toEqual({ display: null, enhanced: null });
    expect(parseSmtpDiagnostic(null)).toEqual({ display: null, enhanced: null });
  });
});

describe("resolveBounceGuidance", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveBounceGuidance>[0];
    key: string;
    category: BounceCategory;
  }> = [
    // Provider hints (highest precedence)
    {
      name: "Apple Private Relay → registered domain",
      input: {
        recipientDomain: "privaterelay.appleid.com",
        diagnosticCode: "550 5.1.1 no such user",
      },
      key: "provider.apple",
      category: "provider",
    },
    {
      name: "iCloud auth block → Apple",
      input: { recipientDomain: "icloud.com", diagnosticCode: "550 5.7.1 blocked" },
      key: "provider.apple",
      category: "provider",
    },
    {
      name: "Gmail bulk-sender auth",
      input: { recipientDomain: "gmail.com", diagnosticCode: "550-5.7.26 unauthenticated" },
      key: "provider.googleBulk",
      category: "provider",
    },
    {
      name: "Outlook SmartScreen block",
      input: { recipientDomain: "outlook.com", diagnosticCode: "550 5.7.1 ... S3140 ..." },
      key: "provider.microsoftBlock",
      category: "provider",
    },
    // Enhanced-code tier
    {
      name: "5.1.1",
      input: { diagnosticCode: "550 5.1.1" },
      key: "code.noMailbox",
      category: "recipient",
    },
    {
      name: "5.1.2",
      input: { diagnosticCode: "550 5.1.2" },
      key: "code.badDomain",
      category: "recipient",
    },
    {
      name: "5.2.1",
      input: { diagnosticCode: "550 5.2.1" },
      key: "code.mailboxDisabled",
      category: "recipient",
    },
    {
      name: "5.2.2",
      input: { diagnosticCode: "550 5.2.2" },
      key: "code.mailboxFull",
      category: "transient",
    },
    {
      name: "4.2.2",
      input: { diagnosticCode: "450 4.2.2" },
      key: "code.mailboxFull",
      category: "transient",
    },
    {
      name: "5.2.3",
      input: { diagnosticCode: "550 5.2.3" },
      key: "code.messageTooLarge",
      category: "content",
    },
    {
      name: "5.4.4",
      input: { diagnosticCode: "550 5.4.4" },
      key: "code.dnsRouting",
      category: "recipient",
    },
    {
      name: "5.7.1",
      input: { diagnosticCode: "550 5.7.1" },
      key: "code.policyBlock",
      category: "policy",
    },
    {
      name: "5.7.26",
      input: { diagnosticCode: "550 5.7.26" },
      key: "code.authFailure",
      category: "policy",
    },
    {
      name: "4.7.x greylist",
      input: { diagnosticCode: "450 4.7.1 greylisted" },
      key: "code.greylisted",
      category: "transient",
    },
    // Subtype tier (no parseable code)
    {
      name: "Permanent/General",
      input: { bounceType: "Permanent", bounceSubType: "General" },
      key: "subtype.permanentGeneral",
      category: "recipient",
    },
    {
      name: "Permanent/NoEmail",
      input: { bounceType: "Permanent", bounceSubType: "NoEmail" },
      key: "subtype.noEmail",
      category: "recipient",
    },
    {
      name: "Permanent/Suppressed",
      input: { bounceType: "Permanent", bounceSubType: "Suppressed" },
      key: "subtype.suppressed",
      category: "reputation",
    },
    {
      name: "Permanent/OnAccountSuppressionList",
      input: { bounceType: "Permanent", bounceSubType: "OnAccountSuppressionList" },
      key: "subtype.onAccountSuppressionList",
      category: "reputation",
    },
    {
      name: "Transient/General",
      input: { bounceType: "Transient", bounceSubType: "General" },
      key: "subtype.transientGeneral",
      category: "transient",
    },
    {
      name: "Transient/MailboxFull",
      input: { bounceType: "Transient", bounceSubType: "MailboxFull" },
      key: "subtype.mailboxFull",
      category: "transient",
    },
    {
      name: "Transient/MessageTooLarge",
      input: { bounceType: "Transient", bounceSubType: "MessageTooLarge" },
      key: "subtype.messageTooLarge",
      category: "content",
    },
    {
      name: "Transient/ContentRejected",
      input: { bounceType: "Transient", bounceSubType: "ContentRejected" },
      key: "subtype.contentRejected",
      category: "content",
    },
    {
      name: "Transient/AttachmentRejected",
      input: { bounceType: "Transient", bounceSubType: "AttachmentRejected" },
      key: "subtype.attachmentRejected",
      category: "content",
    },
    {
      name: "Undetermined/General",
      input: { bounceType: "Undetermined", bounceSubType: "General" },
      key: "subtype.undetermined",
      category: "unknown",
    },
    // Generic tier (unknown subtype)
    {
      name: "Permanent generic",
      input: { bounceType: "Permanent", bounceSubType: "Whatever" },
      key: "generic.permanent",
      category: "recipient",
    },
    {
      name: "Transient generic",
      input: { bounceType: "Transient", bounceSubType: "Whatever" },
      key: "generic.transient",
      category: "transient",
    },
    {
      name: "Undetermined generic",
      input: { bounceType: "Undetermined", bounceSubType: "Whatever" },
      key: "generic.undetermined",
      category: "unknown",
    },
    // Fallback
    { name: "empty input → unknown", input: {}, key: "generic.unknown", category: "unknown" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = resolveBounceGuidance(c.input);
      expect(result.key).toBe(c.key);
      expect(result.category).toBe(c.category);
    });
  }

  it("precedence: provider beats bare enhanced code", () => {
    // Same 5.7.26 resolves to the code tier for an unknown domain,
    // but to the Google provider hint for gmail.com.
    expect(resolveBounceGuidance({ diagnosticCode: "550 5.7.26" }).key).toBe("code.authFailure");
    expect(
      resolveBounceGuidance({ recipientDomain: "gmail.com", diagnosticCode: "550 5.7.26" }).key,
    ).toBe("provider.googleBulk");
  });

  it("precedence: enhanced code beats subtype", () => {
    expect(
      resolveBounceGuidance({
        bounceType: "Transient",
        bounceSubType: "General",
        diagnosticCode: "550 5.1.1",
      }).key,
    ).toBe("code.noMailbox");
  });

  it("iCloud non-auth bounce falls through to the code tier", () => {
    expect(
      resolveBounceGuidance({ recipientDomain: "icloud.com", diagnosticCode: "550 5.2.2 full" })
        .key,
    ).toBe("code.mailboxFull");
  });

  it("carries the display smtpCode through", () => {
    expect(resolveBounceGuidance({ diagnosticCode: "smtp; 550 5.1.1 x" }).smtpCode).toBe(
      "550 5.1.1",
    );
    expect(
      resolveBounceGuidance({ bounceType: "Permanent", bounceSubType: "General" }).smtpCode,
    ).toBeNull();
  });
});

describe("resolveComplaintGuidance", () => {
  const cases: Array<[string | null | undefined, string]> = [
    ["abuse", "complaint.abuse"],
    ["auth-failure", "complaint.authFailure"],
    ["fraud", "complaint.fraud"],
    ["not-spam", "complaint.notSpam"],
    ["virus", "complaint.virus"],
    ["other", "complaint.other"],
    ["unrecognized", "complaint.other"],
    [null, "complaint.other"],
  ];
  for (const [feedbackType, key] of cases) {
    it(`${feedbackType} → ${key}`, () => {
      expect(resolveComplaintGuidance(feedbackType).key).toBe(key);
    });
  }
});

describe("catalog parity", () => {
  const load = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../../apps/web/messages/${locale}/bounce-guidance.json`, import.meta.url),
        ),
        "utf8",
      ),
    );
  const at = (obj: Record<string, unknown>, dotted: string): unknown =>
    dotted.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], obj);

  for (const locale of ["en", "pt-BR"]) {
    it(`every resolver key has title/body/action in ${locale}`, () => {
      const catalog = load(locale);
      for (const key of BOUNCE_GUIDANCE_KEYS) {
        for (const field of ["title", "body", "action"]) {
          expect(at(catalog, `${key}.${field}`), `${locale} missing ${key}.${field}`).toBeTypeOf(
            "string",
          );
        }
      }
    });
  }
});
