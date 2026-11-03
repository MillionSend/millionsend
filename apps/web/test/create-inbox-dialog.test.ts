// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalogs = {
  inboxes: (await import("../messages/en/inboxes.json")).default,
  domains: (await import("../messages/en/domains.json")).default,
  common: (await import("../messages/en/common.json")).default,
};

// The real catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: keyof typeof catalogs) =>
      actual.createTranslator({ locale: "en", messages: catalogs, namespace }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// A plain anchor: the app router a real Link reads is not mounted here.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));
// Queries answer by procedure path; mutations keep their options so a test
// can settle them, and every mutate is recorded.
const rq = vi.hoisted(() => ({
  byPath: {} as Record<string, { data?: unknown; isError?: boolean }>,
  mutations: {} as Record<string, { onSuccess?: () => void }>,
  sent: [] as { path: string; variables: unknown }[],
  succeeded: new Set<string>(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) => ({
    isFetching: false,
    refetch: () => {},
    ...rq.byPath[options.path],
  }),
  useMutation: (options: { path: string; onSuccess?: () => void }) => {
    rq.mutations[options.path] = options;
    return {
      mutate: (variables: unknown) => rq.sent.push({ path: options.path, variables }),
      isPending: false,
      isSuccess: rq.succeeded.has(options.path),
      error: null,
    };
  },
  useQueryClient: () => ({
    setQueryData: rq.setQueryData,
    invalidateQueries: rq.invalidateQueries,
  }),
}));
// Each procedure helper answers with its path and the input or options it was given.
vi.mock("@/lib/trpc", () => {
  const at = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_, key) => at(path ? `${path}.${String(key)}` : String(key)),
      apply: (_, __, [options]) => ({ ...options, path }),
    });
  const root = at("");
  return { useTRPC: () => root };
});

const { CreateInboxDialog } = await import("@/app/(dashboard)/inboxes/create-inbox-dialog");

const MX = "domains.receivingMx.queryOptions";
const ENABLE = "domains.setReceiving.mutationOptions";
const record = { type: "MX", name: "agents.example.com", value: "mx.receiving.test", priority: 10 };
const off = { id: "d-off", name: "agents.example.com", status: "verified" as const };
type Domains = Partial<Parameters<typeof CreateInboxDialog>[0]>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Signed in as the team's owner.
  rq.byPath["team.list.queryOptions"] = {
    data: { activeTeamId: "t1", teams: [{ teamId: "t1", role: "owner" }] },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  rq.byPath = {};
  rq.mutations = {};
  rq.sent = [];
  rq.succeeded.clear();
  rq.setQueryData.mockClear();
  rq.invalidateQueries.mockClear();
});

const render = (domains: Domains) =>
  act(async () =>
    root.render(
      createElement(CreateInboxDialog, {
        open: true,
        onClose: () => {},
        domains: [],
        otherDomains: [],
        sharedDomain: null,
        ...domains,
      }),
    ),
  );
/** The dialog portals to the body. */
const shown = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("the create dialog's address", () => {
  it("keeps the line about the team's own domains while the name fills the address", async () => {
    await render({ otherDomains: [off], sharedDomain: "acme.agents.example" });
    const name = document.getElementById("inbox-name") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        name,
        "Orders agent",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((document.getElementById("inbox-local") as HTMLInputElement).value).toBe("orders-agent");
    expect(shown()).toContain(catalogs.inboxes.create.addressFromName);
    expect(shown()).toContain(
      "Your domains, or the shared acme.agents.example, ready with no DNS.",
    );
  });

  it("turns receiving on in place, then shows the record and moves focus to it", async () => {
    rq.byPath[MX] = { data: { record, status: "missing" } };
    await render({ otherDomains: [off] });
    await act(async () => button("Enable receiving")?.click());
    expect(rq.sent).toEqual([{ path: ENABLE, variables: { id: "d-off", enabled: true } }]);

    rq.succeeded.add(ENABLE);
    await act(async () => rq.mutations[ENABLE]?.onSuccess?.());
    expect(shown()).toContain(catalogs.inboxes.create.receiving.addMxBody);
    expect(button("Check DNS")?.disabled).toBe(false);
    // The Enable button is gone; the card it became holds the focus.
    expect(document.activeElement?.getAttribute("aria-live")).toBe("polite");
    // The pick joins the receiving domains without waiting for a refetch.
    const update = rq.setQueryData.mock.calls[0]?.[1] as (old: unknown) => unknown;
    const pending = { id: "d-new", name: "news.example.com", status: "pending" };
    expect(update({ domains: [], otherDomains: [off, pending], sharedDomain: null })).toEqual({
      domains: [{ id: "d-off", name: "agents.example.com" }],
      otherDomains: [pending],
      sharedDomain: null,
    });
  });

  it("offers a retry, never the switch, when the MX check itself fails", async () => {
    rq.byPath[MX] = { isError: true };
    await render({ otherDomains: [off] });
    expect(shown()).toContain("Couldn't check where agents.example.com gets its mail.");
    expect(button("Check DNS")).toBeDefined();
    expect(button("Enable receiving")).toBeUndefined();
  });
});
