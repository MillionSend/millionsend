import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ members: undefined as unknown, links: undefined as unknown }));

// The real English catalogs, so the test reads what the operator reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    console: (await import("../messages/en/console.json")).default,
    settings: (await import("../messages/en/settings.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "console" }),
  };
});
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options")
          ? (input?: unknown) => ({ path: path.join("."), input })
          : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) => ({
    data:
      options.path === "console.accounts.members"
        ? h.members
        : options.path === "console.accounts.links"
          ? h.links
          : undefined,
  }),
}));

const { MembersSection } = await import("@/components/console/teams/members-section");
const { LinkedTeams } = await import("@/components/console/teams/linked-teams");

const member = {
  userId: "u1",
  name: "Ada",
  email: "ada@acme.dev",
  disposable: false,
  role: "owner",
  signup: {
    ip: "203.0.113.9",
    userAgent: "Firefox",
    at: new Date("2026-10-02T10:00:00Z"),
    geo: { country: "NL", asn: 64500, org: "Example Net" },
  },
  lastSeen: { ip: "198.51.100.2", at: new Date() },
};

describe("the team dialog's members", () => {
  it("shows the sign-up IP's network and country with DB-IP's credit, and marks suspended accounts", () => {
    h.members = {
      geo: true,
      members: [member],
      others: [
        {
          email: "facture@sub.mailinator.com",
          disposable: true,
          ip: "203.0.113.9",
          seen: "signup",
          deleted: false,
          suspension: "phishing",
          abuseSuspended: false,
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(MembersSection, { teamId: "t" }));
    expect(html).toContain("203.0.113.9");
    expect(html).toContain("AS64500 · Example Net");
    expect(html).toContain("🇳🇱 NL");
    expect(html).toContain("198.51.100.2");
    expect(html).toContain("Other accounts on these IPs");
    expect(html).toContain("facture@sub.mailinator.com");
    expect(html).toContain("Temporary address");
    expect(html).toContain("Suspended");
    expect(html).toContain('href="https://db-ip.com"');
    expect(html).toContain("IP geolocation by DB-IP");
  });

  it("drops the network columns and the credit with geolocation off", () => {
    h.members = {
      geo: false,
      members: [{ ...member, signup: { ...member.signup, geo: null } }],
      others: [],
    };
    const html = renderToStaticMarkup(createElement(MembersSection, { teamId: "t" }));
    expect(html).toContain("Sign-up IP");
    expect(html).not.toContain("Network");
    expect(html).not.toContain("DB-IP");
    expect(html).not.toContain("Other accounts on these IPs");
    expect(html).not.toContain("Temporary address");
  });
});

describe("the match with a team suspended for phishing", () => {
  it("lists each shared signal beside the suspended team's, and nothing for an unlinked team", () => {
    h.links = [];
    expect(renderToStaticMarkup(createElement(LinkedTeams, { teamId: "t" }))).toBe("");
    h.links = [
      {
        linkedTeamId: "p",
        linkedTeamName: "facture-vexto",
        matches: [
          {
            kind: "sending_domain",
            value: "cadeaux-vexto.example",
            matched: "vexto-cadeaux.example",
          },
          { kind: "text_hash", value: "ab12", matched: "ab12" },
        ],
        trigger: "domain",
        held: true,
        createdAt: new Date(),
      },
    ];
    const html = renderToStaticMarkup(createElement(LinkedTeams, { teamId: "t" }));
    expect(html).toContain("Matches a team suspended for phishing");
    expect(html).toContain("Sending domain");
    expect(html).toContain("cadeaux-vexto.example");
    expect(html).toContain("vexto-cadeaux.example");
    expect(html).toContain("Same text");
    expect(html).not.toContain("ab12");
    expect(html).toContain('href="/console/safety/p"');
    expect(html).toContain("when a domain was added");
    expect(html).toContain("Held for review at a send: its mail waits until you decide.");
  });
});
