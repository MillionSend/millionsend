import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SES_EVENT_TYPES, SES_IAM_POLICY, SETUP_NAMES } from "../src/setup-constants.js";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const policyActions = new Set<string>(SES_IAM_POLICY.Statement.flatMap((s) => [...s.Action]));

// The runtime AWS modules and their service — every command they construct needs an allow.
const RUNTIME_MODULES = [
  ["../src/domain-identity.ts", "ses"],
  ["../src/send.ts", "ses"],
  ["../src/account.ts", "ses"],
  ["../src/tenants.ts", "ses"],
  ["../src/reputation.ts", "cloudwatch"],
  ["../../../apps/worker/src/sqs-poller.ts", "sqs"],
] as const;

/** CloudFormation's camelCase event names → SESv2's SCREAMING_SNAKE enum. */
const cfnEventToSes = (name: string) => name.replace(/([A-Z])/g, "_$1").toUpperCase();

describe("SES_IAM_POLICY", () => {
  it("allows every AWS command the instance issues", () => {
    for (const [module, service] of RUNTIME_MODULES) {
      const commands = [...read(module).matchAll(/new ([A-Za-z]+)Command\(/g)].map((m) => m[1]);
      expect(commands.length, module).toBeGreaterThan(0);
      for (const command of commands) {
        // SQS authorizes a batch call under its single-message action.
        const action = `${service}:${command?.replace(/Batch$/, "")}`;
        expect(policyActions, `${module}: ${command}`).toContain(action);
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

  it("confines the queue reads to the events queue", () => {
    const queue = SES_IAM_POLICY.Statement.find((s) =>
      (s.Action as readonly string[]).includes("sqs:ReceiveMessage"),
    );
    expect(queue?.Action).toEqual([
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]);
    expect(queue?.Resource).toBe(`arn:aws:sqs:*:*:${SETUP_NAMES.queue}`);
  });
});

describe("infra/millionsend-ses.cfn.yaml", () => {
  const cfn = read("../../../infra/millionsend-ses.cfn.yaml");
  // The managed policy alone: the queue policy names sqs actions of its own.
  const sendPolicy = cfn.split("SendPolicy:")[1]?.split("SendUser:")[0] ?? "";

  it("grants exactly the wizard's actions", () => {
    expect(new Set(sendPolicy.match(/(?:ses|cloudwatch|sqs):[A-Za-z]+/g))).toEqual(policyActions);
    expect(sendPolicy).toContain('Resource: "arn:aws:ses:*:*:identity/*"');
    expect(sendPolicy).toContain('Resource: {"Fn::GetAtt": [EventsQueue, Arn]}');
  });

  it("subscribes exactly the wizard's event types (no open/click/send)", () => {
    const block = cfn.split("MatchingEventTypes:")[1]?.split("SnsDestination:")[0] ?? "";
    const events = [...block.matchAll(/-\s+([A-Za-z]+)/g)].map((m) => cfnEventToSes(m[1] ?? ""));
    expect(new Set(events)).toEqual(new Set(SES_EVENT_TYPES));
  });
});
