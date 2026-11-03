import { describe, expect, it } from "vitest";
import {
  complaintReportingRecipients,
  INACTIVE_MAILBOX_PATTERN,
  MAILBOX_FULL_PATTERN,
  mailboxProvider,
  recipientDomain,
  sentWithoutComplaintFeedback,
  sesAttempted,
  simulatorFeedback,
} from "../src/mailbox-providers.js";

describe("mailboxProvider", () => {
  it("reads consumer webmail by domain and everything else as other", () => {
    expect(mailboxProvider("gmail.com")).toBe("gmail");
    expect(mailboxProvider("GoogleMail.com")).toBe("gmail");
    expect(mailboxProvider("hotmail.com.br")).toBe("microsoft");
    expect(mailboxProvider("outlook.com")).toBe("microsoft");
    expect(mailboxProvider("live.co.uk")).toBe("microsoft");
    expect(mailboxProvider("msn.com")).toBe("microsoft");
    expect(mailboxProvider("yahoo.com.br")).toBe("yahoo");
    expect(mailboxProvider("ymail.com")).toBe("yahoo");
    expect(mailboxProvider("icloud.com")).toBe("apple");
    expect(mailboxProvider("example.com")).toBe("other");
    expect(mailboxProvider("mylive.com")).toBe("other");
    expect(mailboxProvider("outlook.example.com")).toBe("other");
  });
});

describe("mailbox full patterns", () => {
  it("match full and abandoned mailboxes, and only abandoned ones as inactive", () => {
    const full = "452-4.2.2 The recipient's inbox is out of storage space.";
    const abandoned = "552-5.2.2 The recipient's inbox is out of storage space and inactive.";
    expect(MAILBOX_FULL_PATTERN.test(full)).toBe(true);
    expect(MAILBOX_FULL_PATTERN.test(abandoned)).toBe(true);
    expect(MAILBOX_FULL_PATTERN.test("552 5.2.2 user is over quota")).toBe(true);
    expect(MAILBOX_FULL_PATTERN.test("MailboxFull")).toBe(true);
    expect(MAILBOX_FULL_PATTERN.test("550 5.1.1 user unknown")).toBe(false);
    expect(INACTIVE_MAILBOX_PATTERN.test(abandoned)).toBe(true);
    expect(INACTIVE_MAILBOX_PATTERN.test(full)).toBe(false);
  });
});

describe("sesAttempted", () => {
  it("reads SES's own suppression, validation and unsubscribe stops as mail it never attempted", () => {
    for (const subType of [
      "OnAccountSuppressionList",
      "OnTenantSuppressionList",
      "EmailValidationSuppressed",
      "UnsubscribedRecipient",
    ]) {
      expect(sesAttempted(subType)).toBe(false);
    }
    // SES's global list is one it still counts toward the bounce rate.
    for (const subType of ["General", "NoEmail", "Suppressed", undefined, null]) {
      expect(sesAttempted(subType)).toBe(true);
    }
  });
});

describe("complaint feedback by recipient", () => {
  it("reads a stored recipient's domain, display name and case aside", () => {
    expect(recipientDomain("Ana <Ana@Mail.Example.COM>")).toBe("mail.example.com");
    expect(recipientDomain("a@b@example.org")).toBe("example.org");
  });

  it("names the distinct recipients that could report a complaint, never the simulator's", () => {
    expect(
      complaintReportingRecipients([
        "r@outlook.com",
        "r@outlook.com",
        "g@gmail.com",
        "complaint@simulator.amazonses.com",
        "Team <t@example.com>",
      ]),
    ).toEqual(["r@outlook.com", "Team <t@example.com>"]);
  });

  it("leaves mail no recipient could report out of the complaint denominator, simulator mail included", () => {
    expect(sentWithoutComplaintFeedback(["g@gmail.com", "a@icloud.com"])).toBe(true);
    expect(sentWithoutComplaintFeedback(["success@simulator.amazonses.com"])).toBe(true);
    expect(sentWithoutComplaintFeedback(["g@gmail.com", "r@outlook.com"])).toBe(false);
    expect(sentWithoutComplaintFeedback([])).toBe(false);
  });

  it("reads feedback as the simulator's only when every recipient it names is there", () => {
    expect(simulatorFeedback(["bounce@simulator.amazonses.com"])).toBe(true);
    expect(simulatorFeedback(["Complaint+2@Simulator.AmazonSES.com>"])).toBe(true);
    expect(simulatorFeedback(["complaint@simulator.amazonses.com", "r@outlook.com"])).toBe(false);
    expect(simulatorFeedback([])).toBe(false);
  });
});
