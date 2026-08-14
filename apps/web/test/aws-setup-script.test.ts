import { describe, expect, it } from "vitest";
import { buildAwsSetupScript, httpsOrigin } from "@/lib/aws-setup-script";

describe("httpsOrigin", () => {
  it("reduces a valid https URL to its origin", () => {
    expect(httpsOrigin("https://mail.example.com/some/path?q=1")).toBe("https://mail.example.com");
  });

  it("rejects http, garbage, and empty input", () => {
    expect(httpsOrigin("http://mail.example.com")).toBeNull();
    expect(httpsOrigin("not a url")).toBeNull();
    expect(httpsOrigin("")).toBeNull();
    expect(httpsOrigin(null)).toBeNull();
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
      '"MatchingEventTypes":["SEND","DELIVERY","DELIVERY_DELAY","BOUNCE","COMPLAINT","OPEN","CLICK","REJECT","RENDERING_FAILURE"]',
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
