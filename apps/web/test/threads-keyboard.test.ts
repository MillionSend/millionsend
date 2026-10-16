// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const en = {
  inboxes: (await import("../messages/en/inboxes.json")).default,
  common: (await import("../messages/en/common.json")).default,
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
// The page's query string, and what each query answers by procedure path.
const page = vi.hoisted(() => ({ search: "", answers: {} as Record<string, unknown> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(page.search),
}));
// Each label mutation records what it was sent; a create answers with the label it made.
const sent = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) => ({ data: page.answers[options.path] }),
  useInfiniteQuery: (options: { path: string }) => ({
    data: page.answers[options.path],
    isPending: false,
  }),
  useMutation: (options: { path: string; onSuccess?: (label: unknown) => void }) => {
    const procedure = options.path.split(".")[2] as keyof typeof sent;
    return {
      mutate: sent[procedure],
      mutateAsync: async (variables: { name: string; color: string }) => {
        sent[procedure](variables);
        const label = { id: "l9", name: variables.name, color: variables.color };
        options.onSuccess?.(label);
        return label;
      },
      isPending: false,
      error: null,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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

const { ThreadsTab } = await import("@/app/(dashboard)/inboxes/[id]/threads-tab");
const { useEscape } = await import("@/lib/use-escape");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const fn of Object.values(sent)) fn.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T & Element>(selector);
async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
async function click(target: Element | null) {
  await act(async () => (target as HTMLElement).click());
}

describe("Esc on the page", () => {
  function Probe({ onEscape }: { onEscape: () => void }) {
    useEscape(onEscape);
    return createElement(
      "div",
      null,
      createElement("button", { id: "probe-button", type: "button" }),
      createElement("input", { id: "probe-field" }),
    );
  }

  it("runs on an Esc that no field, layer or handler took", async () => {
    const onEscape = vi.fn();
    await act(async () => root.render(createElement(Probe, { onEscape })));
    const button = $("#probe-button") as HTMLElement;
    const esc = (target: Element) => press(target, "Escape");

    await esc(button);
    expect(onEscape).toHaveBeenCalledTimes(1);
    // Typed in a field: never.
    await esc($("#probe-field") as HTMLElement);
    expect(onEscape).toHaveBeenCalledTimes(1);
    // A tooltip that closes on the same Esc, gone before the key reaches window.
    const tip = document.createElement("div");
    tip.className = "ms-tooltip";
    document.body.append(tip);
    const closeTip = () => tip.remove();
    document.addEventListener("keydown", closeTip, { once: true });
    await esc(button);
    expect(tip.isConnected).toBe(false);
    expect(onEscape).toHaveBeenCalledTimes(1);
    // Handled already: prevented, or stopped before window.
    button.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    await esc(button);
    button.addEventListener("keydown", (event) => event.stopPropagation(), { once: true });
    await esc(button);
    expect(onEscape).toHaveBeenCalledTimes(1);
    // An open menu or dialog takes it too.
    const menu = document.createElement("div");
    menu.setAttribute("role", "dialog");
    document.body.append(menu);
    await esc(button);
    menu.remove();
    expect(onEscape).toHaveBeenCalledTimes(1);

    await esc(button);
    expect(onEscape).toHaveBeenCalledTimes(2);
  });
});

describe("the open thread", () => {
  const row = {
    id: "t1",
    subject: "Can't log in after the update",
    from: "Ana Souza <ana@example.com>",
    to: ["support@acme.example"],
    labels: [],
    message_count: 1,
    read: true,
    received_at: new Date().toISOString(),
    folder: "inbox",
    quarantined: 0,
    snippet: "",
  };
  async function openThread() {
    page.search = "thread=t1";
    page.answers = {
      "inboxes.threads.list.infiniteQueryOptions": { pages: [{ items: [row] }] },
      "inboxes.threads.get.queryOptions": row,
      "inboxes.threads.emails.infiniteQueryOptions": { pages: [{ items: [] }] },
      "inboxes.drafts.list.queryOptions": { items: [] },
      "inboxes.labels.list.queryOptions": [],
    };
    await act(async () =>
      root.render(
        createElement(ThreadsTab, {
          inbox: { id: "i1", kind: "human", expired: false } as never,
        }),
      ),
    );
    expect($("section h2")?.textContent).toBe(row.subject);
  }

  it("closes on Esc, focus left in it going back to the thread's row", async () => {
    await openThread();
    const move = $('section button[aria-label="Move"]') as HTMLElement;
    await act(async () => move.focus());
    await press(move, "Escape");
    expect($("section")).toBeNull();
    expect(document.activeElement?.className).toBe("ms-thread-open");
    expect(document.activeElement?.textContent).toContain(row.subject);
  });

  it("stays open for an Esc typed in a field", async () => {
    await openThread();
    const search = $('input[placeholder="Search threads…"]') as HTMLInputElement;
    await act(async () => search.focus());
    await press(search, "Escape");
    expect($("section h2")).not.toBeNull();
    await click($('section button[aria-label="Close"]'));
    expect($("section")).toBeNull();
  });
});
