import { accountMailPhrase, MAIL_LOCALES, type SystemMailMessage } from "@millionsend/core";
import { unescapeHtml } from "@millionsend/core/html";
import { LURE_NAMES, mailLinks, REAL_NAMES, readable } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCS_URL } from "@/lib/docs-links";
import { typedEmail } from "@/lib/email-input";
import {
  buildAccountEmail,
  buildInvitationEmail,
  buildMcpConnectedEmail,
  buildPasswordChangedEmail,
  buildResetEmail,
  buildVerificationEmail,
  buildWelcomeEmail,
} from "@/server/system-mail";

const BASE = "https://app.example.com";
const LINK = `${BASE}/invite/tok`;

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", BASE);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Links a mail carries that are not the instance's own pages, docs or wordmark. */
function foreignLinks(mail: SystemMailMessage): string[] {
  return mailLinks(mail).filter(
    (link) =>
      !link.startsWith(`${BASE}/`) && link !== DOCS_URL && link !== "https://millionsend.com",
  );
}

describe("system mail around customer text shaped like a lure", () => {
  it("carries no link, address or URL of the customer's in its subject or either part", () => {
    for (const lure of LURE_NAMES) {
      for (const locale of MAIL_LOCALES) {
        const mails = [
          buildInvitationEmail({
            to: "billing@acme-support.com",
            inviterName: lure,
            teamName: lure,
            role: "admin",
            url: LINK,
            expiresInDays: 3,
            locale,
          }),
          buildResetEmail({ to: "a@example.com", name: lure, url: LINK, locale }),
          buildVerificationEmail({ to: "a@example.com", name: lure, url: LINK, locale }),
          buildWelcomeEmail({ to: "a@example.com", name: lure, locale }),
          buildPasswordChangedEmail({ to: "billing@acme-support.com", locale }),
          buildMcpConnectedEmail({
            to: "a@example.com",
            app: lure,
            team: lure,
            scopes: ["emails:send"],
            locale,
          }),
          buildAccountEmail({
            to: "a@example.com",
            kind: "team.suspended",
            locale,
            path: "/emails",
            values: {
              team: lure,
              reason: `${accountMailPhrase({ locale, kind: "team.suspended", key: "manual" })} ${accountMailPhrase({ locale, kind: "team.suspended", key: "note", values: { note: lure } })}`,
            },
          }),
        ];
        for (const mail of mails) {
          const where = `${locale} ${mail.kind} ${JSON.stringify(lure)}`;
          expect(foreignLinks(mail), where).toEqual([]);
          expect(readable(mail.subject), where).not.toContain("acme-support");
          expect(`${mail.html}${mail.text}`, where).not.toMatch(
            /mailto:\S|[\u202a-\u202e\u2066-\u2069\u200b]/i,
          );
        }
      }
    }
  });

  it("still reads a team named like a domain as written", () => {
    const mail = buildInvitationEmail({
      to: "new@example.com",
      inviterName: "Ana",
      teamName: "acme.dev",
      role: "member",
      url: LINK,
      expiresInDays: 3,
      locale: "en",
    });
    expect(mail.subject).toBe("You've been invited to a team on MillionSend");
    for (const part of [mail.text, mail.html]) {
      expect(readable(part)).toContain(
        "Ana invited you to join acme.dev on MillionSend as a member.",
      );
      expect(readable(part)).toContain("(new@example.com)");
    }
    expect(foreignLinks(mail)).toEqual([]);
    // The invitee's address, copied from the mail into the sign-up form, is the address again.
    const printed = mail.text.match(/\(([^()]*@[^()]*)\)/)?.[1] ?? "";
    expect(printed).not.toBe("new@example.com");
    expect(typedEmail(printed)).toBe("new@example.com");
  });

  it("prints real names in any script as typed, in both parts and both languages", () => {
    for (const name of REAL_NAMES) {
      for (const locale of MAIL_LOCALES) {
        const mails = [
          buildInvitationEmail({
            to: "new@example.com",
            inviterName: name,
            teamName: name,
            role: "member",
            url: LINK,
            expiresInDays: 3,
            locale,
          }),
          buildVerificationEmail({ to: "a@example.com", name, url: LINK, locale }),
          buildResetEmail({ to: "a@example.com", name, url: LINK, locale }),
        ];
        for (const mail of mails) {
          const where = `${locale} ${mail.kind} ${name}`;
          expect(mail.subject, where).not.toContain(name);
          expect(readable(mail.text), where).toContain(name);
          expect(readable(unescapeHtml(mail.html)), where).toContain(name);
          expect(foreignLinks(mail), where).toEqual([]);
        }
      }
    }
  });
});
