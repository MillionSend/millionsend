import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

const h = vi.hoisted(() => ({ review: undefined as unknown }));

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
// Each procedure's options name its path, and only the review query has data.
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
    options.path === "console.safety.review"
      ? { data: h.review, isPending: false, isError: false, isSuccess: true, refetch: () => {} }
      : { data: undefined, isPending: true, isError: false, isSuccess: false, error: null },
  useMutation: () => ({
    mutate: () => {},
    reset: () => {},
    isPending: false,
    isSuccess: false,
    error: null,
    data: undefined,
  }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));

const { ReviewView } = await import("@/components/console/safety/review-view");
const { TeamDialog } = await import("@/components/console/teams/team-dialog");
const { ViewDialog } = await import("@/components/console/teams/view-dialog");
const { teamMenuItems } = await import("@/components/console/team-actions");

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
    expect(html).toMatch(new RegExp(`owner — · ${copyChip(teamId).source}`));
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
      { supportView: true, silentlySuspended: false, copyId: (id) => copied.push(id) },
    );
    expect(items.slice(0, 3).map((item) => item?.label)).toEqual(["open", "copyId", "view"]);
    items[1]?.onSelect();
    expect(copied).toEqual([teamId]);
  });
});

describe("the View as owner dialog", () => {
  const render = (step: Parameters<typeof ViewDialog>[0]["step"], error: string | null = null) =>
    renderToStaticMarkup(
      createElement(ViewDialog, {
        name: "acme",
        pending: false,
        error,
        step,
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
    expect(html).toContain("Sent to op@example.com. It works once, for 10 minutes.");
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
    expect(html).toContain("A sign-in no longer stands in for the code: email yourself one.");
    expect(html).not.toContain("The code email could not be sent");
    expect(html).toContain("Email me a code");
  });
});
