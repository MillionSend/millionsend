import { readFileSync } from "node:fs";
import type { InboxSafety } from "@millionsend/db/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InboxDetail } from "@/app/(dashboard)/inboxes/parts";
import { dkimSignerDomains, grayExplanation } from "@/lib/auth-result";
import { WEBHOOK_EVENT_META, WEBHOOK_EVENT_TYPES } from "@/lib/webhook-events";

const en = {
  inboxes: (await import("../messages/en/inboxes.json")).default,
  common: (await import("../messages/en/common.json")).default,
  webhooks: (await import("../messages/en/webhooks.json")).default,
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
const h = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown }));
// The form's save goes through the router; rendering never fires it. A test
// sets what every query answers and the error a mutation came back with.
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: h.error }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: h.data }),
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
vi.mock("@/app/(dashboard)/inboxes/[id]/threads-tab", () => ({ ThreadsTab: () => null }));
vi.mock("@/lib/trpc", () => {
  const leaf: unknown = new Proxy(() => ({}), { get: () => leaf, apply: () => ({}) });
  return { useTRPC: () => leaf };
});

const { SafetyForm } = await import("@/app/(dashboard)/inboxes/[id]/safety-tab");
const { InboxView } = await import("@/app/(dashboard)/inboxes/[id]/inbox-view");
const { EditDialog } = await import("@/app/(dashboard)/inboxes/[id]/edit-dialog");
const { CreateInboxDialog } = await import("@/app/(dashboard)/inboxes/create-inbox-dialog");
const { approvalReasonWords, QuarantinedBadge, TrustBadge } = await import(
  "@/app/(dashboard)/inboxes/parts"
);
const { navItemsFor } = await import("@/components/sidebar");
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

function form(inbox: Partial<InboxDetail>, admin = true, stored: InboxSafety = safety) {
  return renderToStaticMarkup(
    createElement(SafetyForm, {
      inbox: { id: "i1", kind: "agent", shared: false, expired: false, ...inbox } as InboxDetail,
      admin,
      stored,
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

  it("hides the injection scan from a people inbox", () => {
    const html = form({ kind: "human" });
    expect(html).not.toContain("Scan for prompt injection");
    expect(html).toContain("Strip hidden text");
    expect(html).toMatch(/id="safety-cap"[^>]*max="100000"/);
  });

  it("shows members the rules read-only", () => {
    const html = form({}, false);
    expect(html).toContain("Only owners and admins can change these rules.");
    expect(html).not.toContain("Save changes");
    expect(html).not.toContain("Add sender");
    expect(html).toContain("*@stripe.com");
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
        }),
      ),
    );
  const fieldError = (html: string) => html.match(/class="ms-field-error"[^>]*>([^<]*)</)?.[1];

  it("takes a username in the create dialog, random when empty, kept until told otherwise", () => {
    h.error = null;
    const html = createDialog();
    expect(html).toMatch(/<input id="inbox-local"[^>]*placeholder="Random address"/);
    const expires = picker(html, "inbox-expires");
    expect(offered(expires)).toEqual(["never", "1h", "24h", "7d", "30d"]);
    expect(expires).toContain('<option value="never" selected="">Never</option>');
  });

  it("words the name review's answers, told apart from other refusals with the same code", () => {
    const shown = (code: string, message: string) => {
      h.error = { data: { code }, message };
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
    h.error = null;
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
    h.error = null;
    expect(offered(picker(edit(), "inbox-edit-expires"))).toContain("never");
    h.error = {
      data: { code: "UNPROCESSABLE_CONTENT" },
      message: "from_name can't be used on the shared domain: pick another",
    };
    expect(fieldError(edit())).toBe(t("create.errors.nameRefused"));
    h.error = null;
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
      h.data = {
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
      h.data = undefined;
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
