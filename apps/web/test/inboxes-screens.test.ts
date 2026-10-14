import { readFileSync } from "node:fs";
import type { InboxSafety } from "@millionsend/db/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InboxDetail, ThreadMessage, ThreadRow } from "@/app/(dashboard)/inboxes/parts";
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
  useParams: () => ({ id: "i1" }),
  useSearchParams: () => new URLSearchParams(),
}));
// What the query hooks answer (nothing unless a test sets it), the error
// a mutation came back with, the options and calls mutations got, and the
// queries invalidated.
const rq = vi.hoisted(() => ({
  data: undefined as unknown,
  pages: undefined as unknown,
  error: null as unknown,
  mutate: vi.fn(),
  mutations: [] as { path?: string; onSuccess?: () => unknown }[],
  invalidate: vi.fn(),
}));
// A server render runs no effect. While `on`, renders run them as a browser
// does across renders: each one whose deps changed since the last render.
const effects = vi.hoisted(() => ({ on: false, next: 0, deps: [] as (unknown[] | undefined)[] }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void, deps?: unknown[]) => {
    if (!effects.on) return;
    const last = effects.deps[effects.next];
    effects.deps[effects.next++] = deps;
    if (!deps || !last || deps.some((dep, i) => !Object.is(dep, last[i]))) effect();
  },
}));
// The form's save goes through the router; rendering never fires it.
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: (typeof rq.mutations)[number]) => {
    rq.mutations.push(options);
    return { mutate: rq.mutate, isPending: false, error: rq.error };
  },
  useQueryClient: () => ({ invalidateQueries: rq.invalidate }),
  useQuery: () => ({ data: rq.data }),
  useInfiniteQuery: () => ({ data: rq.pages, isPending: false }),
}));
// A native select lists every option a picker offers, which a closed one never renders.
vi.mock("@/components/select", () => ({
  Select: (p: {
    id?: string;
    value: string;
    disabled?: boolean;
    options: { value: string; label: string }[];
  }) =>
    createElement(
      "select",
      { id: p.id, value: p.value, disabled: p.disabled, onChange: () => {} },
      p.options.map((o) => createElement("option", { key: o.value, value: o.value }, o.label)),
    ),
}));
// Dialogs portal to document.body, which a server render does not have.
vi.mock("@/components/modal", () => ({
  Modal: (p: { open: boolean; children: React.ReactNode }) =>
    p.open ? createElement("div", null, p.children) : null,
}));
// The inbox page opens on its threads, whose queries no test here answers.
vi.mock("@/app/(dashboard)/inboxes/[id]/threads-tab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/(dashboard)/inboxes/[id]/threads-tab")>()),
  ThreadsTab: () => null,
}));
// Each procedure helper answers with its path and the options it was given.
vi.mock("@/lib/trpc", () => {
  const at = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_, key) => at(path ? `${path}.${String(key)}` : String(key)),
      apply: (_, __, [options]) => ({ ...options, path }),
    });
  const root = at("");
  return { useTRPC: () => root };
});

const { SafetyForm } = await import("@/app/(dashboard)/inboxes/[id]/safety-tab");
const { InboxView } = await import("@/app/(dashboard)/inboxes/[id]/inbox-view");
const { EditDialog } = await import("@/app/(dashboard)/inboxes/[id]/edit-dialog");
const { CreateInboxDialog } = await import("@/app/(dashboard)/inboxes/create-inbox-dialog");
const { ThreadListRow } = await import("@/app/(dashboard)/inboxes/[id]/threads-tab");
const { InboxesView } = await import("@/app/(dashboard)/inboxes/inboxes-view");
const { approvalReasonWords, QuarantinedBadge, replyAllAdds, replyTarget, TrustBadge } =
  await import("@/app/(dashboard)/inboxes/parts");
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
    // It reads them out instead: the unread dot, then the pills.
    const [, prefix] = button.match(/aria-describedby="(\S+)-dot \1-pills"/) ?? [];
    expect(agent).toContain(`id="${prefix}-dot"`);
    expect(agent).toContain(`id="${prefix}-pills"`);
    expect(agent).toContain('aria-label="Your agent hasn&#x27;t marked it read yet"');
    expect(agent).toContain('class="ms-count">3<');
    expect(agent).toContain(">Suspicious<");
    const people = render(false);
    expect(people).toContain('aria-label="Unread"');
    expect(people).not.toContain("Suspicious");
    expect(render(false, true)).toContain("To Rita Recipient");
  });

  it("answers the newest message the inbox sent or let in, never held mail", () => {
    const inbound = (id: string, verdict: string) =>
      ({ id, direction: "inbound", screening: { verdict } }) as ThreadMessage;
    const sent = { id: "sent", direction: "outbound" } as ThreadMessage;
    const held = [inbound("quarantined", "quarantined"), inbound("pending", "pending")];
    expect(replyTarget([inbound("clean", "clean"), sent, ...held])?.id).toBe("sent");
    expect(
      replyTarget([inbound("suspicious", "suspicious"), inbound("released", "released")])?.id,
    ).toBe("released");
    expect(replyTarget(held)).toBeUndefined();
  });

  it("offers Reply all only when it adds someone, as the server copies them", () => {
    const inbox = {
      email_address: "support@acme.example",
      receiving_address: "support@mx.acme.example",
    };
    const inbound = {
      direction: "inbound" as const,
      from: "Ana Souza <ana@example.com>",
      reply_to: [],
      to: ["support@acme.example", "Bruno Lima <bruno@example.com>"],
      cc: ["CARLA@example.com", "ana@example.com", "support@mx.acme.example"],
    };
    expect(replyAllAdds(inbound, inbox)).toEqual(["bruno@example.com", "CARLA@example.com"]);
    // A Reply-To takes the reply, and reply all copies only To and Cc, never the sender.
    expect(
      replyAllAdds(
        { ...inbound, reply_to: ["help@example.com"], to: ["support@acme.example"], cc: [] },
        inbox,
      ),
    ).toEqual([]);
    // The inbox's own send: its To gets the reply, its Cc the reply all.
    const sent = {
      direction: "outbound" as const,
      from: "support@acme.example",
      reply_to: [],
      to: ["ana@example.com", "bruno@example.com"],
      cc: [],
    };
    expect(replyAllAdds(sent, inbox)).toEqual([]);
    expect(
      replyAllAdds({ ...sent, cc: ["carla@example.com", "support@acme.example"] }, inbox),
    ).toEqual(["carla@example.com"]);
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

describe("addresses on the shared domain", () => {
  /** Rendered markup with the apostrophes React escapes put back. */
  const text = (html: string) => html.replaceAll("&#x27;", "'");
  /** The <select> a picker renders as, opening tag to close. */
  const picker = (html: string, id: string) =>
    html.match(new RegExp(`<select id="${id}"[^>]*>.*?</select>`))?.[0] ?? "";
  const offered = (select: string) =>
    [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  const createDialog = () =>
    text(
      renderToStaticMarkup(
        createElement(CreateInboxDialog, {
          open: true,
          onClose: () => {},
          domains: [],
          sharedDomain: "acme.agents.example",
          claiming: false,
        }),
      ),
    );
  const fieldError = (html: string) => html.match(/class="ms-field-error"[^>]*>([^<]*)</)?.[1];

  it("claims the team's subdomain while the empty state names the shared domain, once a showing", () => {
    const empty = {
      pages: [
        {
          items: [],
          counts: { agent: 0, human: 0 },
          overview: { allReceived: { received30d: 0, lastReceived: null }, catchAll: [] },
        },
      ],
    };
    const listed = {
      pages: [
        {
          items: [
            {
              id: "i1",
              email_address: "bot@agents.example",
              name: "",
              kind: "agent",
              unread: 0,
              pending_approval: 0,
              quarantined: 0,
              received_30d: 0,
              last_received: null,
              expires_at: null,
              forward_to: [],
            },
          ],
          counts: { agent: 1, human: 0 },
          overview: null,
        },
      ],
    };
    const claims = (
      pages: unknown,
      sharedSubdomainReady = false,
      domains: { id: string; name: string }[] = [],
    ) => {
      rq.data = { domains, sharedDomain: "agents.example", sharedSubdomainReady, plan: null };
      rq.pages = pages;
      effects.on = true;
      effects.next = 0;
      try {
        renderToStaticMarkup(createElement(InboxesView));
      } finally {
        effects.on = false;
        rq.data = rq.pages = undefined;
      }
      return rq.mutate.mock.calls.length;
    };
    // PageHeader names the browser tab from an effect.
    vi.stubGlobal("document", { title: "" });
    try {
      rq.mutate.mockClear();
      rq.mutations.length = 0;
      effects.deps = [];
      expect([claims(empty), claims(empty), claims(listed), claims(empty)]).toEqual([1, 1, 1, 2]);
      expect(claims(empty, true)).toBe(2);
      // A fresh page whose empty state names no shared domain: the team receives on its own.
      effects.deps = [];
      expect(claims(empty, false, [{ id: "d1", name: "in.acme.example" }])).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
    // A claim refreshes what the picker and the empty state show.
    const claim = rq.mutations.find(
      (options) => options.path === "inboxes.reserveSharedSubdomain.mutationOptions",
    );
    rq.invalidate.mockClear();
    claim?.onSuccess?.();
    expect(rq.invalidate).toHaveBeenCalledWith({ path: "inboxes.options.queryFilter" });
  });

  it("holds a shared address's create while the team's subdomain is being claimed", () => {
    rq.error = null;
    const createButton = (claiming: boolean) =>
      renderToStaticMarkup(
        createElement(CreateInboxDialog, {
          open: true,
          onClose: () => {},
          domains: [],
          sharedDomain: "agents.example",
          claiming,
        }),
      ).match(/<button type="submit"[^>]*>/)?.[0];
    expect(createButton(true)).toContain("disabled");
    expect(createButton(false)).not.toContain("disabled");
  });

  it("takes a username in the create dialog, random when empty, kept until told otherwise", () => {
    rq.error = null;
    const html = createDialog();
    expect(html).toMatch(/<input id="inbox-local"[^>]*placeholder="Random address"/);
    const expires = picker(html, "inbox-expires");
    expect(offered(expires)).toEqual(["never", "1h", "24h", "7d", "30d"]);
    expect(expires).toContain('<option value="never" selected="">Never</option>');
  });

  it("words the name review's answers, told apart from other refusals with the same code", () => {
    const shown = (code: string, message: string) => {
      rq.error = { data: { code }, message };
      return fieldError(createDialog());
    };
    const orRandom = t("create.errors.orRandom");
    expect(
      shown(
        "SERVICE_UNAVAILABLE",
        "This name couldn't be reviewed right now: try again shortly, or leave username out for a random address",
      ),
    ).toBe(`${t("create.errors.reviewUnavailable")} ${orRandom}`);
    expect(
      shown("UNPROCESSABLE_CONTENT", "username can't be used on the shared domain: pick another"),
    ).toBe(`${t("create.errors.nameRefused")} ${orRandom}`);
    for (const spent of ["refused", "reviewed"]) {
      expect(
        shown(
          "TOO_MANY_REQUESTS",
          `Too many names were ${spent} today: try again tomorrow, or leave username out for a random address`,
        ),
      ).toBe(`${t("create.errors.tooManyNames")} ${orRandom}`);
    }
    expect(
      shown("TOO_MANY_REQUESTS", "Too many inboxes created in the last hour. Try again later."),
    ).toBe(t("create.errors.rate"));
    expect(shown("CONFLICT", "This address is already used by an inbox")).toBe(
      t("create.errors.taken"),
    );
    rq.error = null;
  });

  it("offers Never when editing a shared inbox, and words a refused sender name", () => {
    const edit = () =>
      text(
        renderToStaticMarkup(
          createElement(EditDialog, {
            inbox: { id: "i1", name: "Bot", from_name: null, shared: true } as InboxDetail,
            open: true,
            onClose: () => {},
          }),
        ),
      );
    rq.error = null;
    expect(offered(picker(edit(), "inbox-edit-expires"))).toContain("never");
    rq.error = {
      data: { code: "UNPROCESSABLE_CONTENT" },
      message: "from_name can't be used on the shared domain: pick another",
    };
    expect(fieldError(edit())).toBe(t("create.errors.nameRefused"));
    rq.error = null;
  });

  it("offers open on a shared address only while its team may start conversations", () => {
    const policy = (html: string) => picker(html, "safety-policy");
    const open = form({ shared: true, sharedSending: { mode: "open", cause: null } });
    expect(offered(policy(open))).toEqual(["reply_only", "open"]);
    expect(policy(open)).not.toContain("disabled");
    expect(open).toContain(t("policy.reply_onlyHint"));

    const free = form({ shared: true, sharedSending: { mode: "reply_only", cause: "plan" } });
    expect(offered(policy(free))).toEqual(["reply_only"]);
    expect(policy(free)).toContain('disabled=""');
    expect(free).toContain(t("policy.sharedPlan"));
    expect(
      form({ shared: true, sharedSending: { mode: "receive_only", cause: "instance" } }),
    ).toContain(t("policy.sharedPaused"));

    // Open was stored before the mode closed: still listed, so it can be stepped back.
    const stored = form(
      { shared: true, sharedSending: { mode: "reply_only", cause: "instance" } },
      true,
      { ...safety, send_policy: "open" },
    );
    expect(offered(policy(stored))).toEqual(["reply_only", "open"]);
    expect(policy(stored)).not.toContain("disabled");
    expect(stored).toContain(t("policy.sharedOnly"));

    expect(offered(policy(form({})))).toEqual(["reply_only", "allowlist", "open"]);
  });

  it("counts a shared people inbox's daily cap over the API alone", () => {
    const html = text(form({ shared: true, kind: "human" }));
    expect(html).toContain(t("safety.sendCapHintHumanShared"));
    expect(html).not.toContain("SMTP");
  });

  it("says in the inbox header when a shared address can't start conversations", () => {
    const header = (inbox: Partial<InboxDetail>) => {
      rq.data = {
        id: "i1",
        kind: "agent",
        name: "Bot",
        email_address: "bot@acme.agents.example",
        shared: true,
        expired: false,
        expires_at: null,
        received_30d: 0,
        channels: { webhook: false, key: false },
        pending_approval: 0,
        quarantined: 0,
        ...inbox,
      };
      const html = renderToStaticMarkup(createElement(InboxView));
      rq.data = undefined;
      return html.match(/<header[^>]*>.*?<\/header>/s)?.[0] ?? "";
    };
    const SHOWN = /replies only|sending paused/;
    expect(header({ sharedSending: { mode: "reply_only", cause: "plan" } })).toContain(
      "replies only on the Free plan",
    );
    expect(
      header({ kind: "human", sharedSending: { mode: "reply_only", cause: "instance" } }),
    ).toContain("replies only for now");
    expect(header({ sharedSending: { mode: "receive_only", cause: "instance" } })).toContain(
      "sending paused",
    );
    const open = header({ sharedSending: { mode: "open", cause: null } });
    expect(open).toContain("received in 30 days");
    expect(open).not.toMatch(SHOWN);
    expect(header({ shared: false, sharedSending: null })).not.toMatch(SHOWN);
  });
});
