import { readFileSync } from "node:fs";
import type { InboxSafety } from "@millionsend/db/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InboxDetail, ThreadRow } from "@/app/(dashboard)/inboxes/parts";
import { dkimSignerDomains, grayExplanation } from "@/lib/auth-result";
import { typedAllowlistEntry } from "@/lib/email-input";
import { WEBHOOK_EVENT_META, WEBHOOK_EVENT_TYPES } from "@/lib/webhook-events";

const en = {
  inboxes: (await import("../messages/en/inboxes.json")).default,
  common: (await import("../messages/en/common.json")).default,
  webhooks: (await import("../messages/en/webhooks.json")).default,
  nav: (await import("../messages/en/nav.json")).default,
  settings: (await import("../messages/en/settings.json")).default,
};

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: keyof typeof en) =>
      actual.createTranslator({ locale: "en", messages: en, namespace }),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/inboxes",
  useSearchParams: () => new URLSearchParams(),
}));
// What the query hooks answer: nothing unless a test sets it.
const rq = vi.hoisted(() => ({ data: undefined as unknown, pages: undefined as unknown }));
// The form's save goes through the router; rendering never fires it.
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: rq.data }),
  useInfiniteQuery: () => ({ data: rq.pages, isPending: false }),
}));
vi.mock("@/lib/trpc", () => {
  const leaf: unknown = new Proxy(() => ({}), { get: () => leaf, apply: () => ({}) });
  return { useTRPC: () => leaf };
});

const { SafetyForm } = await import("@/app/(dashboard)/inboxes/[id]/safety-tab");
const { ThreadListRow } = await import("@/app/(dashboard)/inboxes/[id]/threads-tab");
const { InboxesView } = await import("@/app/(dashboard)/inboxes/inboxes-view");
const { approvalReasonWords, QuarantinedBadge, TrustBadge } = await import(
  "@/app/(dashboard)/inboxes/parts"
);
const { navItemsFor, Sidebar } = await import("@/components/sidebar");
const { SettingsTabsNav } = await import("@/app/(dashboard)/settings/settings-tabs-nav");
const { ServerTeamRole } = await import("@/lib/use-team-role");
const { offeredEvents } = await import("@/app/(dashboard)/webhooks/webhook-dialogs");
// The mocked hook is a plain function here, typed as the components see it.
const { useTranslations: translatorFor } = await import("next-intl");
const t = translatorFor("inboxes");

const safety = {
  accept_from: "verified" as const,
  allowlist: ["*@stripe.com"],
  owner_addresses: [],
  screening: true,
  extract_codes: true,
  send_policy: "reply_only" as const,
  require_approval: false,
  private_codes: true,
  send_cap: 50,
  forward_to: [],
};

function form(inbox: Partial<InboxDetail>, admin = true, rules: Partial<InboxSafety> = {}) {
  return renderToStaticMarkup(
    createElement(SafetyForm, {
      inbox: { id: "i1", kind: "agent", shared: false, expired: false, ...inbox } as InboxDetail,
      admin,
      stored: { ...safety, ...rules },
      memberEmails: ["owner@acme.test"],
      retentionDays: 30,
    }),
  );
}

describe("gray verdict explanations", () => {
  const detail = (dmarc: { result: string; policy: "none" | "quarantine" | "reject" | null }) => ({
    spf: { result: "pass", domain: "sender.example" },
    dkim: { aligned: [] },
    dmarc: { ...dmarc, domain: "sender.example" },
  });

  it("tells a DMARC pass under p=none from a fail the domain does not ask to block", () => {
    expect(grayExplanation("dmarc", "none", detail({ result: "pass", policy: "none" }))).toBe(
      "dmarcPassNone",
    );
    expect(grayExplanation("dmarc", "none", detail({ result: "fail", policy: "none" }))).toBe(
      "dmarcFailNone",
    );
    expect(grayExplanation("dmarc", "none", detail({ result: "none", policy: null }))).toBe(
      "dmarcNoRecord",
    );
    // An MX that predates the detail leaves only the folded word.
    expect(grayExplanation("dmarc", "none", null)).toBe("dmarcGeneric");
    expect(grayExplanation("dmarc", "pass", null)).toBeNull();
    expect(grayExplanation("dmarc", "fail", null)).toBeNull();
  });

  it("explains DKIM signed elsewhere, SPF soft and silent, and checks that could not run", () => {
    expect(grayExplanation("dkim", "policy", null)).toBe("dkimPolicy");
    expect(grayExplanation("dkim", "pass", null)).toBeNull();
    expect(grayExplanation("spf", "softfail", null)).toBe("spfSoftfail");
    expect(grayExplanation("spf", "neutral", null)).toBe("spfNeutral");
    expect(grayExplanation("spf", "none", null)).toBe("spfNeutral");
    for (const check of ["spf", "dkim", "dmarc"] as const) {
      expect(grayExplanation(check, "temperror", null)).toBe("checkError");
      expect(grayExplanation(check, "permerror", null)).toBe("checkError");
    }
    expect(grayExplanation("arc", "none", null)).toBeNull();
  });

  it("has every explanation in both languages, naming the signer where DKIM needs one", () => {
    const pt = JSON.parse(
      readFileSync(new URL("../messages/pt-BR/inboxes.json", import.meta.url), "utf8"),
    ) as typeof en.inboxes;
    for (const key of Object.keys(en.inboxes.gray)) {
      expect(pt.gray[key as keyof typeof pt.gray], key).toBeTruthy();
    }
    expect(t("gray.dkimPolicy", { domains: "mailer.example" })).toContain("mailer.example");
    expect(pt.gray.dmarcPassNone).toContain("p=none");
  });

  it("reads the signing domains off DKIM-Signature headers, the From domain left out", () => {
    const headers = "v=1; a=rsa-sha256; d=mailer.example; s=s1; b=x\nv=1; d=Sender.example; s=k";
    expect(dkimSignerDomains(headers, "sender.example")).toEqual(["mailer.example"]);
    expect(dkimSignerDomains("", "sender.example")).toEqual([]);
  });
});

describe("navigation", () => {
  it("offers Inboxes, after Emails, only where the instance takes mail", () => {
    expect(navItemsFor(false).map((item) => item.key)).not.toContain("inboxes");
    const keys = navItemsFor(true).map((item) => item.key);
    expect(keys.slice(0, 2)).toEqual(["emails", "inboxes"]);
  });

  // useQuery is mocked to no data: what the server and the hydrating render see.
  it("has Inboxes in the server HTML, before any query answers", () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, { teamName: "Acme", userEmail: "owner@example.com", receiving: true }),
    );
    expect(html).toContain('href="/inboxes"');
  });

  it("gates on the layout's role in the server HTML, before the team list loads", () => {
    const tabs = (role: "admin" | "member") =>
      renderToStaticMarkup(
        createElement(
          ServerTeamRole,
          { value: role },
          createElement(SettingsTabsNav, {
            showBilling: false,
            showSes: true,
            showSmtp: true,
            showReceiving: false,
          }),
        ),
      );
    expect(tabs("admin")).toContain(">Audit log<");
    expect(tabs("member")).not.toContain(">Audit log<");
  });

  it("sends the old received-mail links to their new home", async () => {
    const config = await (await import("../next.config")).default("phase-development-server");
    const redirects = (await config.redirects?.()) ?? [];
    expect(redirects).toContainEqual({
      source: "/emails",
      has: [{ type: "query", key: "source", value: "receiving" }],
      destination: "/inboxes/received",
      permanent: false,
    });
    expect(redirects).toContainEqual({
      source: "/emails/receiving/:id",
      destination: "/inboxes/received/:id",
      permanent: false,
    });
  });
});

describe("webhook picker", () => {
  it("offers received mail and inbox events only where mail is taken, every inbox event opt-in", () => {
    const off = offeredEvents(false);
    expect(off.types).not.toContain("email.received");
    expect(off.types.some((type) => type.startsWith("inbox."))).toBe(false);
    expect(off.groups).not.toContain("receiving");
    expect(off.groups).not.toContain("inboxes");

    const on = offeredEvents(true);
    expect(on.types).toEqual(WEBHOOK_EVENT_TYPES);
    expect(on.groups).toContain("inboxes");
    const inboxEvents = WEBHOOK_EVENT_TYPES.filter((type) => type.startsWith("inbox."));
    expect(inboxEvents).toHaveLength(14);
    for (const type of inboxEvents) {
      expect(WEBHOOK_EVENT_META[type], type).toMatchObject({ group: "inboxes", optIn: true });
    }
    // email.received is not opt-in: it keeps reaching "all events" endpoints.
    expect(WEBHOOK_EVENT_META["email.received"]).toEqual(
      expect.not.objectContaining({ optIn: true }),
    );
  });
});

describe("inbox screens", () => {
  it("says who a sender is and why mail is held, in words", () => {
    const html = renderToStaticMarkup(
      createElement("div", null, [
        createElement(TrustBadge, { key: "a", trust: "failed" }),
        createElement(TrustBadge, { key: "b", trust: "known_thread" }),
        createElement(QuarantinedBadge, { key: "c", reason: "injection" }),
      ]),
    );
    expect(html).toContain('class="ms-badge ms-badge-danger">Failed authentication<');
    expect(html).toContain('class="ms-badge ms-badge-success">Known thread<');
    expect(html).toContain("Quarantined · prompt injection");
  });

  it("puts every reason a send waits into words, keeping a detail's key out", () => {
    expect(approvalReasonWords(t, ["loop_guard:auto_submitted", "ramp", "unknown_reason"])).toBe(
      "a reply to an automatic message · too many new recipients today · unknown_reason",
    );
    // What activity rows record: refusals, sends and quarantines.
    expect(
      approvalReasonWords(t, ["inbox_send_cap_reached", "restricted_api_key", "not_allowlisted"]),
    ).toBe(
      "the inbox's daily send limit was reached · a key restricted to another inbox · not on the allowlist",
    );
  });

  it("offers a shared address only replies, within its 50 sends a day", () => {
    const html = form({ shared: true });
    expect(html).toContain("Addresses on the shared domain only reply inside their threads.");
    expect(html).toMatch(/id="safety-cap"[^>]*max="50"/);
    expect(html).toContain("Scan for prompt injection");
    expect(html).toContain("Save changes");
  });

  it("shows a people inbox only the rules that run on it", () => {
    const html = form({ kind: "human" });
    expect(html).not.toContain("Scan for prompt injection");
    expect(html).toContain("Strip hidden text");
    expect(html).toContain("When mail arrives");
    // Send rules and the always-on guards bind only an agent's own sends.
    expect(html).toContain("Sending over the API");
    expect(html).not.toContain("Send policy");
    expect(html).not.toContain("Always on:");
    expect(html).toMatch(/id="safety-cap"[^>]*max="100000"/);
  });

  it("warns an agent inbox open to anyone, and explains anyone on a people inbox instead", () => {
    const warning = "Also lets in mail whose sender";
    const agent = form({}, true, { accept_from: "anyone" });
    expect(agent).toContain(warning);
    expect(agent).toContain("Takes mail from any sender");
    const people = form({ kind: "human" }, true, { accept_from: "anyone" });
    expect(people).not.toContain(warning);
    expect(people).toContain("Like a regular mailbox");
    expect(form({})).not.toContain(warning);
  });

  it("keeps owner addresses off the shared domain, which forwards to team members only", () => {
    expect(form({})).toContain('id="safety-owners"');
    expect(form({ shared: true })).not.toContain('id="safety-owners"');
  });

  it("reads a typed domain as an allowlist domain entry", () => {
    expect(typedAllowlistEntry(" Acme.example ")).toBe("*@acme.example");
    expect(typedAllowlistEntry("@acme.example")).toBe("*@acme.example");
    expect(typedAllowlistEntry("*@acme.example")).toBe("*@acme.example");
    expect(typedAllowlistEntry("Ana@Acme.example")).toBe("ana@acme.example");
  });

  it("says why no inbox can be created yet, and where to fix it", () => {
    const page = (sharedDomain: string | null) => {
      rq.data = { domains: [], sharedDomain, plan: { used: 0, limit: 3 } };
      rq.pages = {
        pages: [
          {
            items: [],
            counts: { agent: 0, human: 0 },
            overview: { allReceived: { received30d: 0, lastReceived: null }, catchAll: [] },
          },
        ],
      };
      const html = renderToStaticMarkup(createElement(InboxesView));
      rq.data = rq.pages = undefined;
      return html;
    };
    const nowhere = page(null);
    expect(nowhere).toMatch(/class="ms-tooltip-trigger inline"[^>]*><button[^>]*disabled/);
    expect(nowhere).toContain('href="/domains"');
    expect(nowhere).not.toContain("shared");
    const shared = page("inboxes.example");
    expect(shared).toContain("Create an address at inboxes.example");
    expect(shared).not.toContain("disabled");
  });

  it("counts unread as needing attention in people inboxes only", () => {
    const inbox = (kind: string, address: string, unread: number) => ({
      id: address,
      email_address: address,
      name: "",
      kind,
      unread,
      pending_approval: 0,
      quarantined: 0,
      received_30d: 0,
      last_received: null,
      expires_at: null,
      forward_to: [],
    });
    rq.data = { domains: [], sharedDomain: "inboxes.example", plan: { used: 2, limit: 3 } };
    rq.pages = {
      pages: [
        {
          items: [inbox("agent", "bot@acme.example", 5), inbox("human", "team@acme.example", 3)],
          counts: { agent: 1, human: 1 },
          overview: null,
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(InboxesView));
    rq.data = rq.pages = undefined;
    // The agent's unread is its own queue.
    expect(html).toContain("3 unread");
    expect(html).not.toContain("5 unread");
  });

  it("lays a thread out on one line whose button wraps no other stop", () => {
    const row = {
      id: "t1",
      subject: "Order #8841",
      from: "Sam Sender <sam@example.com>",
      to: ["Rita Recipient <rita@example.com>"],
      cc: [],
      bcc: [],
      labels: [{ id: "l1", name: "Billing", color: "#C0A8E1" }],
      message_count: 3,
      has_attachment: false,
      has_draft: false,
      read: false,
      received_at: new Date().toISOString(),
      folder: "inbox",
      quarantined: 0,
      quarantine_reason: null,
      injection_score: 62,
      phishing_score: 12,
      suspicious: true,
      pending_approval: false,
      snippet: "It never arrived",
    } as ThreadRow;
    const render = (agent: boolean, sent = false) =>
      renderToStaticMarkup(
        createElement(ThreadListRow, { row, agent, sent, selected: true, onOpen: () => {} }),
      );
    const agent = render(true);
    const button = agent.match(/<button[^>]*class="ms-thread-open"[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button).toContain('aria-current="true"');
    expect(button).toContain("Order #8841");
    expect(button).toContain("It never arrived");
    // The time, the dot and the pills are its siblings, each its own stop.
    expect(button).not.toMatch(/tabindex|<time/);
    expect(agent).toContain('aria-label="Your agent hasn&#x27;t marked it read yet"');
    expect(agent).toContain('class="ms-count">3<');
    expect(agent).toContain(">Suspicious<");
    const people = render(false);
    expect(people).toContain('aria-label="Unread"');
    expect(people).not.toContain("Suspicious");
    expect(render(false, true)).toContain("To Rita Recipient");
  });

  it("shows members the rules read-only", () => {
    const html = form({}, false);
    expect(html).toContain("Only owners and admins can change these rules.");
    expect(html).not.toContain("Save changes");
    expect(html).toMatch(/id="safety-allowlist"[^>]*disabled/);
    // A typed entry outside any option list still shows as its chip.
    expect(html).toContain("*@stripe.com");
    expect(html).toContain("Mail is kept for 30 days.");
  });
});
