// @vitest-environment jsdom

import { DAY_MS, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDayUtc } from "@/lib/format";
import { createCaller } from "@/server/routers";

const h = vi.hoisted(() => ({
  review: undefined as unknown,
  monitor: undefined as unknown,
  guard: vi.fn(),
  mutated: [] as unknown[],
  /** The last mutate call's callbacks. */
  callbacks: undefined as
    | { onSuccess?: (data: unknown) => void; onError?: (error: unknown) => Promise<void> }
    | undefined,
  refetch: vi.fn<() => Promise<{ data: unknown }>>(),
  toast: vi.fn(),
}));

// The real English catalogs, so the test reads what the operator reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    console: (await import("../messages/en/console.json")).default,
    settings: (await import("../messages/en/settings.json")).default,
    emails: (await import("../messages/en/emails.json")).default,
    domains: (await import("../messages/en/domains.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: "en",
        messages,
        namespace: namespace as keyof typeof messages,
      }),
  };
});
// Dialogs portal to document.body, which a server render does not have.
vi.mock("@/components/modal", () => ({
  Modal: ({ title, children }: { title?: string; children: React.ReactNode }) =>
    createElement("div", { "data-title": title }, children),
}));
// Each procedure's options name its path, and only the review and settings queries have data.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") || key === "queryKey" || key === "queryFilter"
          ? (input?: unknown) => ({ path: path.join("."), input })
          : at([...path, key]),
    });
  return { useTRPC: () => at([]), useTRPCClient: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) =>
    options.path === "console.safety.review" || options.path === "console.monitor.settings.get"
      ? {
          data: options.path === "console.safety.review" ? h.review : h.monitor,
          isPending: false,
          isError: false,
          isSuccess: true,
          refetch: h.refetch,
        }
      : { data: undefined, isPending: true, isError: false, isSuccess: false, error: null },
  useMutation: () => ({
    mutate: (variables: unknown, callbacks?: typeof h.callbacks) => {
      h.mutated.push(variables);
      h.callbacks = callbacks;
    },
    reset: () => {},
    isPending: false,
    isSuccess: false,
    error: null,
    data: undefined,
  }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
// The guard's prompts need a browser; a server render can only check it is wired.
vi.mock("@/lib/use-unsaved-warning", () => ({ useUnsavedChangesWarning: h.guard }));
vi.mock("@/components/toast", () => ({ toast: h.toast }));
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));

const { ReviewView } = await import("@/components/console/safety/review-view");
const { TeamDialog } = await import("@/components/console/teams/team-dialog");
const { ViewDialog } = await import("@/components/console/teams/view-dialog");
const { SuspendDialog } = await import("@/components/console/teams/hold-dialogs");
const { teamMenuItems } = await import("@/components/console/team-actions");
const { MonitorSettingsView, Field } = await import("@/components/console/safety/monitor-settings");
const consoleEn = (await import("../messages/en/console.json")).default;
const commonEn = (await import("../messages/en/common.json")).default;

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const operatorId = crypto.randomUUID();

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: operatorId, name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  teamId = await createTeam(db, "acme");
});
afterAll(() => close());

/**
 * The chip a value an engineer pastes sits in: the whole value, wrapping
 * on a narrow screen rather than cut off, then its copy button.
 */
const copyChip = (value: string) =>
  new RegExp(
    `<span class="ms-chip"><span style="min-width:0;overflow-wrap:anywhere">${value}</span><button type="button" aria-label="Copy"`,
  );

describe("the team's id on the console's team screens", () => {
  it("heads the team dialog's details, whole and copyable, before the detail loads", () => {
    const html = renderToStaticMarkup(
      createElement(TeamDialog, {
        id: teamId,
        name: "acme",
        detail: undefined,
        onClose: () => {},
        onAdjustLimits: () => {},
        onViewAsOwner: () => {},
      }),
    );
    expect(html).toMatch(new RegExp(`<dt>Team ID</dt><dd>${copyChip(teamId).source}`));
  });

  it("closes the review page's meta line", async () => {
    h.review = await createCaller({
      db,
      session: {
        user: { id: operatorId, email: "op@example.com", name: "Operator" },
        session: { id: crypto.randomUUID(), createdAt: new Date() },
      },
      teamId: null,
      role: null,
    }).console.safety.review({ teamId });
    const html = renderToStaticMarkup(createElement(ReviewView, { teamId }));
    // The chip is the meta line's last " · " part (DotParts), so the line
    // breaks before it rather than inside "owner …".
    expect(html).toMatch(
      new RegExp(
        `<span class="ms-part">owner —\u00a0·</span> <span class="ms-part">${copyChip(teamId).source}`,
      ),
    );
  });

  it("leads the review page with the warm-up card while a limit request is open", async () => {
    const asking = await createTeam(db, "asking");
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId: asking, name: "mail.asking.example", region: "us-east-1" })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    const caller = createCaller({
      db,
      session: {
        user: { id: operatorId, email: "op@example.com", name: "Operator" },
        session: { id: crypto.randomUUID(), createdAt: new Date() },
      },
      teamId: null,
      role: null,
    });
    const warmupFirst = async () => {
      h.review = await caller.console.safety.review({ teamId: asking });
      const html = renderToStaticMarkup(createElement(ReviewView, { teamId: asking }));
      return html.indexOf(">Domain warm-up</h3>") < html.indexOf(">Monitoring</h3>");
    };
    expect(await warmupFirst()).toBe(false);
    await db.insert(schema.domainLimitRequests).values({
      teamId: asking,
      domainId: domain.id,
      sends: "account",
      perDay: 2000,
      source: "new",
    });
    expect(await warmupFirst()).toBe(true);
  });

  it("is one Copy ID away in the Teams list's row menu", () => {
    const copied: string[] = [];
    const team = {
      id: teamId,
      name: "acme",
      plan: "free",
      planQuota: null,
      suspendedAt: null,
      broadcastsPausedByOperatorAt: null,
    };
    const noop = () => {};
    const items = teamMenuItems(
      team,
      {
        openTeam: noop,
        adjustLimits: noop,
        changePlan: noop,
        pauseBroadcasts: noop,
        resumeBroadcasts: noop,
        suspend: noop,
        reinstate: noop,
        viewAsOwner: noop,
        dialogs: null,
      },
      (key) => key,
      { supportView: true, copyId: (id) => copied.push(id) },
    );
    expect(items.slice(0, 3).map((item) => item?.label)).toEqual(["open", "copyId", "view"]);
    items[1]?.onSelect();
    expect(copied).toEqual([teamId]);
  });
});

describe("the Teams list's row menu", () => {
  it("opens the team's Trust & safety review page", () => {
    const visited: string[] = [];
    const noop = () => {};
    const items = teamMenuItems(
      {
        id: teamId,
        name: "acme",
        plan: "free",
        planQuota: null,
        suspendedAt: null,
        broadcastsPausedByOperatorAt: null,
      },
      {
        openTeam: noop,
        adjustLimits: noop,
        changePlan: noop,
        pauseBroadcasts: noop,
        resumeBroadcasts: noop,
        suspend: noop,
        reinstate: noop,
        viewAsOwner: noop,
        dialogs: null,
      },
      (key) => consoleEn.teams.menu[key as keyof typeof consoleEn.teams.menu],
      { supportView: true, navigate: (href) => visited.push(href) },
    );
    expect(items.slice(0, 2).map((item) => item?.label)).toEqual([
      "Open team",
      "Open in Trust & safety",
    ]);
    items[1]?.onSelect();
    expect(visited).toEqual([`/console/safety/${teamId}`]);
  });
});

describe("the review page's Lift sending pause", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The clock stands still, so the review's pause window and this suite's
    // agree even when a UTC midnight passes mid-test.
    vi.useFakeTimers({ now: new Date().setUTCHours(12, 30, 0, 0), toFake: ["Date"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    h.refetch.mockImplementation(async () => ({ data: h.review }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    h.mutated = [];
    h.callbacks = undefined;
    h.refetch.mockReset();
    h.toast.mockReset();
  });

  /** A new team's review page, its counters reading `today`, and its lift button if any. */
  async function open(
    slug: string,
    today?: Omit<typeof schema.usageCounters.$inferInsert, "teamId" | "day">,
    flag?: Omit<typeof schema.teamFlags.$inferInsert, "teamId">,
  ) {
    const id = await createTeam(db, slug);
    if (today)
      await db.insert(schema.usageCounters).values({ teamId: id, day: utcDay(), ...today });
    if (flag) await db.insert(schema.teamFlags).values({ teamId: id, ...flag });
    h.review = await createCaller({
      db,
      session: {
        user: { id: operatorId, email: "op@example.com", name: "Operator" },
        session: { id: crypto.randomUUID(), createdAt: new Date() },
      },
      teamId: null,
      role: null,
    }).console.safety.review({ teamId: id });
    await act(async () => root.render(createElement(ReviewView, { teamId: id })));
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Lift sending pause",
    );
    return { id, button };
  }
  const type = (field: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) =>
    act(async () => {
      if (!field) throw new Error("no field");
      const proto = Object.getPrototypeOf(field) as HTMLInputElement | HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const liftDialog = () => container.querySelector('[data-title^="Lift sending pause"]');
  /** A paused team's lift confirmed in its dialog, the mutation's callbacks left in h.callbacks. */
  async function confirmLift(slug: string) {
    const { button } = await open(slug, { sent: 200, hardBounced: 20 });
    await act(async () => button?.click());
    await type(liftDialog()?.querySelector("input"), "Ticket 1042");
    await type(
      liftDialog()?.querySelector("textarea"),
      "Fake sign-ups. The form checks addresses now.",
    );
    await act(async () =>
      liftDialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
    );
  }

  it("is offered while a bounce pause holds, and not at all otherwise", async () => {
    expect((await open("lift-quiet")).button).toBeUndefined();
    expect((await open("lift-paused", { sent: 200, hardBounced: 20 })).button?.disabled).toBe(
      false,
    );
  });

  it("is disabled under a refusal, the reason one focus away", async () => {
    const { button } = await open("lift-complaints", { sent: 200, complained: 4 });
    expect(button?.disabled).toBe(true);
    // The wrapper takes the focus the disabled button cannot.
    const trigger = button?.parentElement;
    expect(trigger?.className).toBe("ms-tooltip-trigger inline");
    expect(trigger?.tabIndex).toBe(0);
    await act(async () => trigger?.focus());
    expect(document.querySelector(".ms-tooltip")?.textContent).toBe(
      "Paused on complaints, which a lift never covers. The pause lifts on its own once those send days leave the 2-day window.",
    );
  });

  it("confirms only once the reference and the note both hold more than spaces", async () => {
    const { id, button } = await open("lift-confirm", { sent: 200, hardBounced: 20 });
    await act(async () => button?.click());
    const dialog = container.querySelector('[data-title="Lift sending pause · lift-confirm"]');
    const since = formatDayUtc(utcDay(Date.now() - DAY_MS), "en");
    expect(dialog?.textContent).toContain("Paused onHard-bounce rate 10.00% over the last 2 days");
    expect(dialog?.textContent).toContain(
      `Leaves out20 hard bounces in 200 sends since ${since} UTC`,
    );
    expect(dialog?.textContent).toContain("Waiting to go outNothing");
    expect(dialog?.textContent).toContain("Last liftNever");
    const confirm = () => dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(confirm()?.disabled).toBe(true);
    await type(dialog?.querySelector("input"), "  Ticket 1042 ");
    expect(confirm()?.disabled).toBe(true);
    await type(dialog?.querySelector("textarea"), "   ");
    expect(confirm()?.disabled).toBe(true);
    await type(dialog?.querySelector("textarea"), "Fake sign-ups. The form checks addresses now.");
    expect(confirm()?.disabled).toBe(false);
    await act(async () => confirm()?.click());
    expect(h.mutated).toEqual([
      {
        id,
        reference: "Ticket 1042",
        note: "Fake sign-ups. The form checks addresses now.",
        notify: true,
      },
    ]);
  });

  it("reads the page at once and again after the flag sync, unless it was left", async () => {
    await confirmLift("lift-synced");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    h.refetch.mockClear();
    const lifted = () => act(async () => h.callbacks?.onSuccess?.({ sent: 200, hardBounces: 20 }));
    await lifted();
    expect(h.toast).toHaveBeenCalledWith(
      "Sending resumed for lift-synced · 20 hard bounces left out",
    );
    expect(liftDialog()).toBeNull();
    expect(h.refetch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(35_000));
    expect(h.refetch).toHaveBeenCalledTimes(2);
    // Left before the flag sync runs: nothing reads the page once it is gone.
    await lifted();
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTime(35_000));
    expect(h.refetch).toHaveBeenCalledTimes(3);
  });

  it("answers a refused confirm with the refusal, dated from a fresh read", async () => {
    await confirmLift("lift-refused");
    const review = h.review as { standing: { pauseLift: object } };
    h.refetch.mockResolvedValueOnce({
      data: {
        ...review,
        standing: {
          ...review.standing,
          pauseLift: {
            ...review.standing.pauseLift,
            refusal: "cooldown",
            lastLiftAt: new Date("2026-08-14T15:00:00.000Z"),
            nextLiftAt: new Date("2026-09-14T00:00:00.000Z"),
          },
        },
      },
    });
    await act(async () =>
      h.callbacks?.onError?.({ data: { code: "PRECONDITION_FAILED" }, message: "cooldown" }),
    );
    expect(liftDialog()).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(
      "Lifted on Aug 14. The next lift is possible from Sep 14.",
      "danger",
    );
  });

  it("tells on the hard-bounce tile what a lift left out of the rate", async () => {
    await open("lift-lifted", {
      sent: 300,
      hardBounced: 20,
      excludedSent: 200,
      excludedHardBounced: 20,
    });
    const label = [...container.querySelectorAll<HTMLElement>(".ms-tooltip-trigger")].find(
      (el) => el.textContent === "Hard bounces 7d",
    );
    await act(async () => label?.focus());
    expect(document.querySelector(".ms-tooltip")?.textContent).toBe(
      "The rate leaves out 20 hard bounces and 200 sends lifted after review.",
    );
  });

  it("marks a flag the cron has cleared on the Flag card", async () => {
    await open(
      "lift-cleared",
      { sent: 300 },
      {
        reason: "guardrail",
        status: "cleared",
        detail: { guardrail: "paused", metric: "hard_bounce", rate: 0.07 },
        clearedAt: new Date(),
      },
    );
    const card = [...container.querySelectorAll("h3")]
      .find((title) => title.textContent === "Flag")
      ?.closest(".ms-card");
    expect(card?.querySelector(".ms-badge")?.textContent).toBe("Cleared");
  });
});

describe("the View as owner dialog", () => {
  const render = (
    step: Parameters<typeof ViewDialog>[0]["step"],
    error: string | null = null,
    verifiedUntil: Date | null = null,
  ) =>
    renderToStaticMarkup(
      createElement(ViewDialog, {
        name: "acme",
        pending: false,
        error,
        step,
        verifiedUntil,
        onClose: () => {},
        onSendCode: () => {},
        onSubmit: () => {},
      }),
    );

  it("emails the code first", () => {
    const html = render(null);
    expect(html).toContain("Email me a code");
    expect(html).not.toContain("Code from your email");
  });

  it("then takes the code, says where it went and offers a new one", () => {
    const html = render({ sent: true, to: "op@example.com", minutes: 10 });
    expect(html).toContain("Code from your email");
    expect(html).toContain('autoComplete="one-time-code"');
    // A narrow dialog breaks the address after its "@" and dots, never mid-label.
    expect(html).toContain("Sent to op@<wbr/>example.<wbr/>com. It works once, for 10 minutes.");
    expect(html).toContain("Send a new code");
    expect(html).toContain("Start session · 30 min");
  });

  it("says why a sign-in stands in when the code cannot go out, and whether it is recent", () => {
    const noMail = render({ sent: false, reason: "no_mail", signedInRecently: true, minutes: 15 });
    expect(noMail).toContain("This instance cannot send email (it needs AUTH_EMAIL_FROM");
    expect(noMail).toContain("a sign-in from the last 15 minutes stands in for it.");
    expect(noMail).toContain("Yours is recent enough: start the session.");
    expect(noMail).not.toContain("Code from your email");
    const failed = render({
      sent: false,
      reason: "send_failed",
      signedInRecently: false,
      minutes: 15,
    });
    expect(failed).toContain("The code email could not be sent");
    expect(failed).toContain("Yours is older: sign out and back in, then start it again.");
  });

  it("offers a code again once the server stops letting the sign-in stand in", () => {
    const html = render(
      { sent: false, reason: "send_failed", signedInRecently: true, minutes: 15 },
      "code_required",
    );
    expect(html).toContain("A code is needed now: email yourself one.");
    expect(html).not.toContain("The code email could not be sent");
    expect(html).toContain("Email me a code");
  });

  it("goes straight to the start while a code confirmed in this session covers it", () => {
    const until = new Date(Date.now() + 5 * 60_000);
    const html = render(null, null, until);
    expect(html).toContain("Start session · 30 min");
    expect(html).not.toContain("Email me a code");
    expect(html).not.toContain("Code from your email");
    expect(html).toMatch(
      /The code you confirmed in this session still covers starting a view \(0[45]:\d\d left\)\./,
    );
    // The server's clock ended it first: a code again.
    const lapsed = render(null, "code_required", until);
    expect(lapsed).toContain("Email me a code");
    expect(lapsed).not.toContain("still covers");
  });
});

describe("the Suspend dialog's cancel and refund", () => {
  const render = (
    initialReason: "phishing" | "reputation" | "manual" | "non_payment",
    refundPlan: string | null | undefined,
  ) =>
    renderToStaticMarkup(
      createElement(SuspendDialog, {
        name: "acme",
        initialReason,
        refundPlan,
        pending: false,
        onClose: () => {},
        onSubmit: () => {},
      }),
    );
  /** The checkbox's input tag, or null when the dialog does not offer it. */
  const box = (html: string) => html.match(/<input id="[^"]*-refund"[^>]*>/)?.[0] ?? null;
  const submit = (html: string) => html.match(/<button type="submit"[^>]*>/)?.[0];

  it("is ticked by default for phishing and unticked for reputation and other reasons", () => {
    const phishing = render("phishing", "Pro 100K");
    expect(phishing).toContain("Cancel Pro 100K in Stripe and refund the last 120 days as fraud");
    expect(box(phishing)).toContain('checked=""');
    for (const reason of ["reputation", "manual"] as const) {
      const unticked = box(render(reason, "Pro 100K"));
      expect(unticked).toContain('type="checkbox"');
      expect(unticked).not.toContain("checked");
    }
  });

  it("is never offered on non-payment or without a live subscription", () => {
    expect(box(render("non_payment", "Pro 100K"))).toBeNull();
    expect(box(render("phishing", null))).toBeNull();
    expect(submit(render("phishing", null))).not.toContain("disabled");
  });

  it("holds the submit until the subscription is known", () => {
    const loading = render("phishing", undefined);
    expect(box(loading)).toBeNull();
    expect(submit(loading)).toContain('disabled=""');
  });
});

describe("the console's monitoring settings", () => {
  it("shows every setting, the shared domain's four in a group of their own", async () => {
    const got = await createCaller({
      db,
      session: {
        user: { id: operatorId, email: "op@example.com", name: "Operator" },
        session: { id: crypto.randomUUID(), createdAt: new Date() },
      },
      teamId: null,
      role: null,
    }).console.monitor.settings.get();
    h.monitor = got;
    const html = renderToStaticMarkup(createElement(MonitorSettingsView))
      .replaceAll("&#x27;", "'")
      .replaceAll("&amp;", "&");
    const { fields } = consoleEn.safety.monitor;
    for (const { key } of got.settings) {
      expect(html, key).toContain(`>${fields[key as keyof typeof fields]}</label>`);
    }
    expect(html).toMatch(
      /Shared domain<.*Shared addresses send<.*Start conversations<.*Each team's SES tenant<.*Recipients per team per day</s,
    );
    expect(html).not.toContain("not saved yet");
    expect(h.guard).toHaveBeenCalledWith(false, commonEn.unsavedWarn);
  });

  it("marks a changed value as not saved yet, never as set here", () => {
    const field = (
      stored: Pick<Parameters<typeof Field>[0]["setting"], "value" | "source">,
      draft: boolean | null | undefined,
    ) =>
      renderToStaticMarkup(
        createElement(Field, {
          setting: { key: "sharedInboxOpen", fallback: false, kind: "bool", ...stored },
          draft,
          invalid: false,
          disabled: false,
          onChange: () => {},
          onReset: () => {},
        }),
      );
    const toggled = field({ value: false, source: "default" }, true);
    expect(toggled).toContain(">on<");
    expect(toggled).toContain("not saved yet");
    expect(toggled).not.toContain("set here");
    const untouched = field({ value: true, source: "db" }, undefined);
    expect(untouched).toContain("set here");
    expect(untouched).not.toContain("not saved yet");
    // A null draft is a pending reset, which has not happened yet either.
    const resetting = field({ value: true, source: "db" }, null);
    expect(resetting).toContain(">off<");
    expect(resetting).toContain("not saved yet");
    expect(resetting).not.toContain("built-in default");
  });
});
