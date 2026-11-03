import { describe, expect, it } from "vitest";
import { customHeaderIssues, hasHeaderControlChar } from "../src/custom-headers.js";

describe("customHeaderIssues", () => {
  it("passes threading headers and X- headers, and nothing the transport owns", () => {
    expect(
      customHeaderIssues({
        "In-Reply-To": "<a@x.example>",
        References: "<a@x.example> <b@y.example>",
        "X-Ticket": "42",
        "OTP-Token": '"123456"; origin="https://example.com"',
      }),
    ).toEqual([]);
    expect(customHeaderIssues({ "X-SES-Configuration-Set": "x" })[0]?.message).toMatch(
      /not an allowed header/,
    );
    expect(customHeaderIssues({ "X-MillionSend-Forwarded": "x" })).toHaveLength(1);
    expect(customHeaderIssues({ "Auto-Submitted": "auto-replied" })).toHaveLength(1);
    expect(customHeaderIssues({ "Bad Name": "x" })[0]?.message).toMatch(/not a valid header name/);
  });

  it("refuses a vetted name given twice in different cases; X- headers may repeat", () => {
    const otp = '"123456"; origin="https://example.com"';
    expect(customHeaderIssues({ "OTP-Token": otp, "otp-token": otp })).toEqual([
      { header: "otp-token", message: '"otp-token" may appear only once' },
    ]);
    expect(customHeaderIssues({ "X-Tag": "a", "x-tag": "b" })).toEqual([]);
  });

  it("refuses values that could smuggle a header line", () => {
    expect(customHeaderIssues({ References: "<a@x>\r\nBcc: victim@x.example" })).toEqual([
      { header: "References", message: '"References" value must not contain control characters' },
    ]);
    expect(hasHeaderControlChar("tab\tis fine")).toBe(false);
  });

  it("wants both one-click unsubscribe headers, with an https target", () => {
    expect(customHeaderIssues({ "List-Unsubscribe": "<https://x.example/u>" })).toEqual([
      {
        header: "List-Unsubscribe",
        message: "List-Unsubscribe and List-Unsubscribe-Post must be sent together",
      },
    ]);
    expect(
      customHeaderIssues({
        "List-Unsubscribe": "<mailto:u@x.example>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }).map((issue) => issue.header),
    ).toEqual(["List-Unsubscribe"]);
  });
});
