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

const { LabelsMenu } = await import("@/app/(dashboard)/inboxes/[id]/labels");
const { ThreadsTab } = await import("@/app/(dashboard)/inboxes/[id]/threads-tab");
const { useEscape } = await import("@/lib/use-escape");
const { useLocalDraft } = await import("@/lib/use-local-draft");

const billing = { id: "l1", name: "Billing", color: "#46A758" };
const followUp = { id: "l2", name: "Follow-up", color: "#F76B15" };

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
/** Types into a controlled field the way React hears it. */
async function type(field: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
async function click(target: Element | null) {
  await act(async () => (target as HTMLElement).click());
}

async function openMenu(onChange = vi.fn(), onCreated = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(LabelsMenu, {
        inboxId: "i1",
        labels: [billing, followUp],
        value: [billing.id],
        onChange,
        onCreated,
      }),
    ),
  );
  await click($('[role="combobox"]'));
  return $<HTMLInputElement>(".ms-menu-search") as HTMLInputElement;
}

describe("the labels picker", () => {
  it("creates a new name in the swatch picked under it, or the random one Enter alone keeps", async () => {
    const onCreated = vi.fn();
    const search = await openMenu(vi.fn(), onCreated);
    expect($(".ms-swatches")).toBeNull();
    await type(search, "Refund");
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>(".ms-menu .ms-swatch[type=radio]"),
    ];
    expect(radios).toHaveLength(11);
    const random = radios.filter((radio) => radio.checked);
    expect(random).toHaveLength(1);
    expect($('.ms-menu input[type="color"]')?.getAttribute("aria-label")).toBe("Custom color");
    await press(search, "Enter");
    expect(sent.create).toHaveBeenLastCalledWith({
      inboxId: "i1",
      name: "Refund",
      color: random[0]?.value,
    });
    // Made, it goes on the thread, and the search clears for the next pick.
    expect(onCreated).toHaveBeenCalledWith({ id: "l9", name: "Refund", color: random[0]?.value });
    expect(search.value).toBe("");

    await type(search, "Refund later");
    await click($('.ms-menu .ms-swatch[aria-label="Purple"]'));
    await press(search, "Enter");
    expect(sent.create).toHaveBeenLastCalledWith({
      inboxId: "i1",
      name: "Refund later",
      color: "#AB4ABA",
    });
  });

  it("opens a label's edit view with → or the pencil, without picking it", async () => {
    const onChange = vi.fn();
    const search = await openMenu(onChange);
    // The active row carries the pencil; assistive tech, which the pencil
    // is hidden from, hears about → on every row.
    const pencil = $('.ms-menu [role="option"].active .ms-menu-edit');
    expect(pencil?.getAttribute("title")).toBe("Edit label");
    for (const option of document.querySelectorAll('.ms-menu [role="option"]')) {
      expect(option.getAttribute("aria-keyshortcuts")).toBe("ArrowRight");
      const hint = document.getElementById(option.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toBe("Press the right arrow to edit this label");
    }
    await click(pencil);
    expect(onChange).not.toHaveBeenCalled();
    expect($<HTMLInputElement>('.ms-menu input[aria-label="Name"]')?.value).toBe("Billing");
    // The view names itself as focus lands in it.
    expect($('.ms-menu fieldset[aria-label="Edit label"] input[aria-label="Name"]')).not.toBeNull();
    expect($<HTMLInputElement>('.ms-menu .ms-swatch[aria-label="Green"]')?.checked).toBe(true);

    await click($('.ms-menu button[aria-label="Back"]'));
    const back = $<HTMLInputElement>(".ms-menu-search");
    expect(back).not.toBeNull();
    // Inside the typed text → moves the caret; past its end it opens the row.
    await type(back as HTMLInputElement, "foll");
    (back as HTMLInputElement).setSelectionRange(1, 1);
    await press(back as HTMLInputElement, "ArrowRight");
    expect($(".ms-menu-search")).not.toBeNull();
    (back as HTMLInputElement).setSelectionRange(4, 4);
    await press(back as HTMLInputElement, "ArrowRight");
    expect($<HTMLInputElement>('.ms-menu input[aria-label="Name"]')?.value).toBe("Follow-up");
    expect(search.isConnected).toBe(false);
  });

  it("saves only what changed, and refuses a name another label has before sending it", async () => {
    const search = await openMenu();
    await press(search, "ArrowRight");
    const name = $<HTMLInputElement>('.ms-menu input[aria-label="Name"]') as HTMLInputElement;
    await type(name, "follow-UP");
    expect($(".ms-menu .ms-field-error")?.textContent).toBe(
      "A label with this name already exists.",
    );
    expect($<HTMLButtonElement>('.ms-menu button[type="submit"]')?.disabled).toBe(true);

    await type(name, " Invoices ");
    expect($(".ms-menu .ms-field-error")).toBeNull();
    await click($('.ms-menu button[type="submit"]'));
    expect(sent.update).toHaveBeenLastCalledWith({
      inboxId: "i1",
      labelId: "l1",
      name: "Invoices",
    });

    await click($('.ms-menu .ms-swatch[aria-label="Cyan"]'));
    await type(name, "Billing");
    await click($('.ms-menu button[type="submit"]'));
    expect(sent.update).toHaveBeenLastCalledWith({
      inboxId: "i1",
      labelId: "l1",
      color: "#00A2C7",
    });
  });

  it("deletes a label only once its confirm, in place, says yes", async () => {
    const search = await openMenu();
    await press(search, "ArrowRight");
    const ask = () => $(".ms-menu button.ms-menu-item.danger");
    await click(ask());
    expect($(".ms-menu p")?.textContent).toBe("Delete “Billing”? It's removed from every thread.");
    // The safe answer takes focus; backing out returns it to the button that asked.
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(document.activeElement);
    expect(document.activeElement).toBe(ask());
    expect(sent.delete).not.toHaveBeenCalled();

    await click(ask());
    await click($(".ms-menu .ms-btn-destructive"));
    expect(sent.delete).toHaveBeenCalledWith({ inboxId: "i1", labelId: "l1" });
  });

  it("keeps Tab inside the panel while it holds more than its search, and Esc steps back", async () => {
    const search = await openMenu();
    await press(search, "ArrowRight");
    const back = $('.ms-menu button[aria-label="Back"]') as HTMLElement;
    const save = $('.ms-menu button[type="submit"]') as HTMLElement;
    await act(async () => save.focus());
    await press(save, "Tab");
    expect(document.activeElement).toBe(back);
    await press(document.activeElement as Element, "Escape");
    // Out of the edit view, back to the list; one more Esc closes the menu.
    const list = $(".ms-menu-search") as HTMLElement;
    expect(list).not.toBeNull();
    await press(list, "Escape");
    expect($(".ms-menu")).toBeNull();
  });
});

describe("Esc on the page", () => {
  function Probe({ onEscape }: { onEscape: () => void }) {
    useEscape(onEscape);
    return createElement(
      "div",
      null,
      createElement("button", { id: "probe-button", type: "button" }),
      createElement("input", { id: "probe-field" }),
      createElement(
        "div",
        { className: "ms-maily" },
        createElement("button", { id: "probe-bold", type: "button" }),
      ),
    );
  }

  it("runs on an Esc that no field, layer or handler took", async () => {
    const onEscape = vi.fn();
    await act(async () => root.render(createElement(Probe, { onEscape })));
    const button = $("#probe-button") as HTMLElement;
    const esc = (target: Element) => press(target, "Escape");

    await esc(button);
    expect(onEscape).toHaveBeenCalledTimes(1);
    // Typed in a field, or anywhere in the message editor: never.
    await esc($("#probe-field") as HTMLElement);
    await esc($("#probe-bold") as HTMLElement);
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
    labels: [] as (typeof billing)[],
    message_count: 1,
    read: true,
    received_at: new Date().toISOString(),
    folder: "inbox",
    quarantined: 0,
    snippet: "",
  };
  const next = { ...row, id: "t2", subject: "Invoice for October" };
  async function openThread(
    thread: Partial<typeof row> = {},
    answers: Record<string, unknown> = {},
  ) {
    page.search = "thread=t1";
    page.answers = {
      "inboxes.threads.list.infiniteQueryOptions": { pages: [{ items: [row, next] }] },
      "inboxes.threads.get.queryOptions": { ...row, ...thread },
      "inboxes.threads.emails.infiniteQueryOptions": { pages: [{ items: [] }] },
      "inboxes.drafts.list.queryOptions": { items: [] },
      "inboxes.labels.list.queryOptions": [],
      ...answers,
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

  it("hands focus to the row beside a thread that leaves the list", async () => {
    await openThread({ folder: "spam" });
    const notSpam = [...document.querySelectorAll<HTMLElement>("section button")].find(
      (button) => button.textContent === "Not spam",
    ) as HTMLElement;
    await act(async () => notSpam.focus());
    await click(notSpam);
    const [variables, options] = sent.update.mock.calls[0] as [object, { onSuccess: () => void }];
    expect(variables).toMatchObject({ threadId: "t1", folder: "inbox" });
    await act(async () => options.onSuccess());
    expect($("section")).toBeNull();
    expect(document.activeElement?.textContent).toContain(next.subject);
  });

  it("moves focus off a label's ✕ before its badge goes", async () => {
    await openThread({ labels: [billing, followUp] });
    const remove = $('section button[aria-label="Remove Billing"]') as HTMLElement;
    await act(async () => remove.focus());
    await click(remove);
    expect(sent.update).toHaveBeenCalledWith({
      inboxId: "i1",
      threadId: "t1",
      removeLabelId: "l1",
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove Follow-up");
  });

  it("stays open on Esc while a draft is being edited, which is kept nowhere else", async () => {
    await openThread(
      {},
      {
        "inboxes.drafts.list.queryOptions": {
          items: [{ id: "d1", thread_id: "t1", status: "pending_approval", approval_reasons: [] }],
        },
        "inboxes.drafts.get.queryOptions": {
          text: "Hi Ana, it's fixed.",
          created_at: new Date().toISOString(),
        },
      },
    );
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLElement>("section button")].find(
        (el) => el.textContent === label,
      ) as HTMLElement;
    await click(button("Edit"));
    const save = button("Save draft");
    await act(async () => save.focus());
    await press(save, "Escape");
    expect($("section textarea")).not.toBeNull();
    expect($("section h2")).not.toBeNull();
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

describe("a local draft", () => {
  function Probe({ text }: { text: string }) {
    useLocalDraft({ storageKey: "ms-draft:probe", state: text, initialState: "" });
    return null;
  }

  it("is written when its editor goes before the debounce does", async () => {
    localStorage.removeItem("ms-draft:probe");
    await act(async () => root.render(createElement(Probe, { text: "" })));
    await act(async () => root.render(createElement(Probe, { text: "Thanks, I'll check" })));
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(JSON.parse(localStorage.getItem("ms-draft:probe") ?? "{}").data).toBe(
      "Thanks, I'll check",
    );
    localStorage.removeItem("ms-draft:probe");
  });
});
