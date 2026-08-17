import { describe, expect, it } from "vitest";
import { buildAwsSetupScript, cfnQuickCreateUrl } from "@/lib/aws-setup-script";

describe("cfnQuickCreateUrl", () => {
  it("targets the console review page for the given region", () => {
    const url = cfnQuickCreateUrl("sa-east-1");
    expect(url).toContain("region=sa-east-1");
    expect(url).toContain("stackName=millionsend");
    expect(url).toContain("millionsend-public.s3.amazonaws.com/millionsend-ses.cfn.yaml");
  });
});

describe("buildAwsSetupScript", () => {
  it("substitutes the region and creates policy, user, and access key", () => {
    const script = buildAwsSetupScript({ region: "sa-east-1" });
    expect(script).toContain('REGION="sa-east-1"');
    expect(script).toContain("aws iam create-policy --policy-name millionsend-ses");
    expect(script).toContain("aws iam create-user --user-name millionsend");
    expect(script).toContain("aws iam attach-user-policy");
    expect(script).toContain("aws iam create-access-key");
    // jq-free: key parsing goes through --query/--output text, never jq.
    expect(script).toContain("--output text");
    expect(script).not.toContain("jq");
  });

  it("rejects a region that is not shell-safe", () => {
    expect(() => buildAwsSetupScript({ region: 'us-east-1"; rm -rf /' })).toThrow(/invalid/);
  });

  it("includes the events section only for a valid https appBaseUrl", () => {
    const script = buildAwsSetupScript({
      region: "us-east-1",
      appBaseUrl: "https://mail.example.com",
      includeEvents: true,
    });
    expect(script).toContain("aws sns create-topic --name millionsend-events");
    expect(script).toContain('--notification-endpoint "https://mail.example.com/ses/events"');
    expect(script).toContain(
      "aws sesv2 create-configuration-set --configuration-set-name millionsend",
    );
    expect(script).toContain(
      '"MatchingEventTypes":["DELIVERY","DELIVERY_DELAY","BOUNCE","COMPLAINT","REJECT","RENDERING_FAILURE"]',
    );
    expect(script).toContain('echo "SNS_TOPIC_ARNS=$TOPIC_ARN"');
    expect(script).toContain('echo "SES_CONFIGURATION_SET=millionsend"');
  });

  it("omits events for http or missing appBaseUrl", () => {
    for (const appBaseUrl of ["http://mail.example.com", undefined]) {
      const script = buildAwsSetupScript({ region: "us-east-1", appBaseUrl, includeEvents: true });
      expect(script).not.toContain("sns");
      expect(script).not.toContain("SES_CONFIGURATION_SET");
    }
  });

  it("never interpolates the raw appBaseUrl — only its sanitized origin", () => {
    const nasty = "https://mail.example.com/$(rm -rf /)?x='y'";
    const script = buildAwsSetupScript({
      region: "us-east-1",
      appBaseUrl: nasty,
      includeEvents: true,
    });
    expect(script).toContain('"https://mail.example.com/ses/events"');
    expect(script).not.toContain("rm -rf");
  });
});
