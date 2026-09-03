import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SES_EVENT_TYPES, SES_IAM_POLICY } from "../src/setup-constants.js";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const policyActions = new Set<string>(SES_IAM_POLICY.Statement.flatMap((s) => [...s.Action]));

// The runtime SES modules — every command they construct needs an allow.
const RUNTIME_MODULES = [
  "../src/domain-identity.ts",
  "../src/send.ts",
  "../src/account.ts",
  "../src/tenants.ts",
];

/** CloudFormation's camelCase event names → SESv2's SCREAMING_SNAKE enum. */
const cfnEventToSes = (name: string) => name.replace(/([A-Z])/g, "_$1").toUpperCase();

describe("SES_IAM_POLICY", () => {
  it("allows every SES command the instance issues", () => {
    for (const module of RUNTIME_MODULES) {
      const commands = [...read(module).matchAll(/new ([A-Za-z]+)Command\(/g)].map((m) => m[1]);
      expect(commands.length, module).toBeGreaterThan(0);
      for (const command of commands) {
        expect(policyActions, `${module}: ${command}`).toContain(`ses:${command}`);
      }
    }
  });

  it("confines identity actions to identity ARNs", () => {
    const identity = SES_IAM_POLICY.Statement.find((s) =>
      (s.Action as readonly string[]).includes("ses:DeleteEmailIdentity"),
    );
    expect(identity?.Resource).toBe("arn:aws:ses:*:*:identity/*");
    expect(identity?.Action).toContain("ses:PutEmailIdentityDkimSigningAttributes");
    // GetAccount has no resource-level scope, so it must not sit in the identity statement.
    expect(identity?.Action).not.toContain("ses:GetAccount");
  });
});

describe("infra/millionsend-ses.cfn.yaml", () => {
  const cfn = read("../../../infra/millionsend-ses.cfn.yaml");

  it("grants exactly the wizard's SES actions", () => {
    expect(new Set(cfn.match(/ses:[A-Za-z]+/g))).toEqual(policyActions);
    expect(cfn).toContain('Resource: "arn:aws:ses:*:*:identity/*"');
  });

  it("subscribes exactly the wizard's event types (no open/click/send)", () => {
    const block = cfn.split("MatchingEventTypes:")[1]?.split("SnsDestination:")[0] ?? "";
    const events = [...block.matchAll(/-\s+([A-Za-z]+)/g)].map((m) => cfnEventToSes(m[1] ?? ""));
    expect(new Set(events)).toEqual(new Set(SES_EVENT_TYPES));
  });
});
