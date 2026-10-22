// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerInitial } from "@/app/(dashboard)/broadcasts/composer";

// The composer is a client component; a static render with the data hooks
// stubbed is enough to see which editor mounts and what the body shows. The
// same stubs drive the jsdom tests, which click through the mode switch.
vi.mock("next-intl", () => {
  const t = (ns: string) =>
    Object.assign((key: string) => `${ns}.${key}`, {
      rich: (key: string) => `${ns}.${key}`,
      raw: (key: string) => `${ns}.${key}`,
    });
  return { useTranslations: t, useLocale: () => "en" };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/broadcasts",
  useSearchParams: () => new URLSearchParams(),
}));
const rq = vi.hoisted(() => ({
  /** The save mutations: one stub each, so a test sees which request went out. */
  update: vi.fn(),
  create: vi.fn(),
  /** Every other mutation (test send, send). */
  other: vi.fn(),
  /** fetchQuery of trpc.email.render, which "Edit as HTML" calls for the source. */
  render: vi.fn(),
  /** fetchQuery of trpc.templates.get, which the template picker calls. */
  template: vi.fn(),
  /** The confirmation before a template replaces a body with content. */
  confirm: vi.fn(),
  /** What the debounced email.render query holds; every other query is empty. */
  rendered: { data: undefined as unknown },
  /** The template picker's rows. */
  templates: [] as { id: string; name: string }[],
  /** Whether the save mutations report a request in flight. */
  saving: false,
  /** The props the block editor last mounted with. */
  blockEditor: null as null | {
    value: { document: unknown; html: string };
    convertHtml?: boolean;
    onChange: (value: { document: unknown }) => void;
  },
}));
// The block editor never loads in tests: its loader is replaced by a marker.
vi.mock("next/dynamic", () => ({
  default: () => (props: NonNullable<typeof rq.blockEditor>) => {
    rq.blockEditor = props;
    return createElement("div", { "data-block-editor": "" });
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options?: { path?: string }) => {
    if (options?.path === "email.render.queryOptions") return rq.rendered;
    if (options?.path === "templates.list.queryOptions") return { data: { items: rq.templates } };
    return { data: undefined };
  },
  useInfiniteQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useMutation: (options?: { path?: string }) => {
    const run =
      options?.path === "broadcasts.update.mutationOptions"
        ? rq.update
        : options?.path === "broadcasts.create.mutationOptions"
          ? rq.create
          : rq.other;
    return {
      mutateAsync: run,
      mutate: run,
      reset: vi.fn(),
      isPending: run !== rq.other && rq.saving,
      isError: false,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    fetchQuery: (options: { path?: string; input?: unknown; retry?: boolean }) =>
      options.path === "email.render.queryOptions"
        ? rq.render({ input: options.input, retry: options.retry })
        : rq.template({ input: options.input }),
  }),
}));
// Any trpc.<path>.<helper>(...) call resolves to an options object that names
// its path and keeps its input, so the stubs above can tell the calls apart.
vi.mock("@/lib/trpc", () => {
  const router = (path: string[]): unknown =>
    new Proxy(() => ({}), {
      get: (_target, key) => router([...path, String(key)]),
      apply: (_target, _receiver, args) => ({ path: path.join("."), input: args[0] }),
    });
  const root = router([]);
  return { useTRPC: () => root };
});
// Portals cannot render statically; the dialog's frame is inlined instead.
// Its hidden button stands in for Esc and the overlay click, which call onClose.
vi.mock("@/components/modal", () => ({
  Modal: ({
    open,
    title,
    children,
    onClose,
  }: {
    open: boolean;
    title?: string;
    children: unknown;
    onClose: () => void;
  }) =>
    open
      ? createElement(
          "div",
          { role: "dialog", "aria-modal": "true" },
          createElement("button", {
            type: "button",
            hidden: true,
            "data-escape": "",
            onClick: onClose,
          }),
          title,
          children as never,
        )
      : null,
}));
vi.mock("@/components/confirm-dialog", () => ({ confirmDialog: rq.confirm }));
// The picker's popover needs layout; each option becomes a plain button.
vi.mock("@/components/select", () => ({
  Select: ({
    id,
    options,
    onChange,
    ariaLabel,
    disabled,
  }: {
    id?: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    ariaLabel: string;
    disabled?: boolean;
  }) =>
    createElement(
      "div",
      { id, role: "group", "aria-label": ariaLabel },
      options.map((option) =>
        createElement(
          "button",
          {
            key: option.value,
            type: "button",
            disabled,
            onClick: () => onChange(option.value),
          },
          option.label,
        ),
      ),
    ),
}));

const { BroadcastComposer } = await import("@/app/(dashboard)/broadcasts/composer");
const { PacingSteps, SendPlanSummary } = await import("@/app/(dashboard)/broadcasts/parts");
type SendPlanWarmup = import("@/app/(dashboard)/broadcasts/parts").SendPlanWarmup;

const MAILY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const HTML_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  topicId: null,
  segmentId: null,
  name: "Launch",
  from: "Ada <ada@news.example.com>",
  subject: "Hi",
  replyTo: null,
  html: '<table><tr><td style="padding:8px">Hi {{{FIRST_NAME|there}}}</td></tr></table>',
  text: null,
  document: null,
};

describe("broadcast composer body mode", () => {
  it("opens an html-authored draft on the preview with the banner and no block editor", () => {
    const out = renderToStaticMarkup(createElement(BroadcastComposer, { initial: HTML_ROW }));
    expect(out).not.toContain("data-block-editor");
    expect(out).toContain("templates.html.banner");
    expect(out).toContain("templates.html.editHtml");
    expect(out).toContain("templates.html.convert");
    // The stored html is what the preview shows, byte for byte.
    expect(out).toContain("<iframe");
    expect(out).toContain("padding:8px");
  });

  it("opens a block-authored draft in the block editor, with no html banner", () => {
    const out = renderToStaticMarkup(
      createElement(BroadcastComposer, { initial: { ...HTML_ROW, document: MAILY_DOC } }),
    );
    expect(out).toContain("data-block-editor");
    expect(out).not.toContain("templates.html.banner");
  });
});

const BLOCKS = { type: "doc", content: [{ type: "image" }] };
const EDITED = { type: "doc", content: [{ type: "image" }, { type: "button" }] };
const OTHER_BLOCKS = { type: "doc", content: [{ type: "divider" }] };
/** A saved broadcast written in the block editor, with the html that editor rendered. */
const BLOCK_ROW: ComposerInitial = {
  ...HTML_ROW,
  html: "<p>Blocks</p>",
  text: "Blocks",
  document: BLOCKS,
};
/** A saved broadcast whose block editor holds only the empty paragraph. */
const EMPTY_ROW: ComposerInitial = { ...HTML_ROW, html: "", text: "", document: MAILY_DOC };

const EDIT_AS_HTML = "templates.html.editAsHtml";
const BACK_TO_BLOCKS = "templates.html.backToBlocks";
const IN_PLACE = "broadcasts.composer.convertInPlace";
const SAVE = "broadcasts.composer.saveDraft";

const HTML_TEMPLATE = {
  subject: "Legacy",
  html: "<p>Legacy</p>",
  text: "Legacy",
  document: null,
};
const BLOCK_TEMPLATE = {
  subject: "Fresh",
  html: "<p>Fresh</p>",
  text: "Fresh",
  document: OTHER_BLOCKS,
};
/** The picker's rows for the two templates above. */
const TEMPLATE_ROWS = [
  { id: "t-html", name: "Legacy HTML" },
  { id: "t-blocks", name: "Fresh blocks" },
];

const draftKey = (initial?: ComposerInitial) => `ms-draft:broadcast:${initial?.id ?? "new"}`;

describe("broadcast composer html switch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    rq.update.mockReset().mockResolvedValue({ id: HTML_ROW.id });
    rq.create.mockReset().mockResolvedValue({ id: HTML_ROW.id });
    rq.other.mockReset().mockResolvedValue({});
    rq.render.mockReset().mockResolvedValue({ html: "<p>Current</p>", text: "Current" });
    rq.template.mockReset();
    rq.confirm.mockReset().mockResolvedValue(true);
    rq.rendered = { data: undefined };
    rq.templates = [];
    rq.blockEditor = null;
    rq.saving = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function buttonFor(label: string) {
    return Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.trim().startsWith(label),
    );
  }

  async function click(label: string) {
    const button = buttonFor(label);
    expect(button, label).toBeDefined();
    await act(async () => button?.click());
  }

  /** Types into a field the way the browser does: set the value, fire input. */
  async function type(selector: string, value: string) {
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    expect(field, selector).not.toBeNull();
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(field, value);
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const mount = (initial?: ComposerInitial) =>
    act(async () => root.render(createElement(BroadcastComposer, initial ? { initial } : {})));

  /** A new broadcast, past the targeting step and on its content. */
  async function mountNew() {
    await mount();
    await click("broadcasts.composer.continue");
  }

  /** What the block editor emits when the user edits: the document alone. */
  const editBlocks = (document: unknown) => act(async () => rq.blockEditor?.onChange({ document }));

  /** A saved block broadcast, switched to HTML in place. */
  async function switched(initial: ComposerInitial = BLOCK_ROW) {
    await mount(initial);
    await click(EDIT_AS_HTML);
    await click(IN_PLACE);
  }

  const source = () => container.querySelector<HTMLTextAreaElement>("textarea#bc-html");
  const dialog = () => container.querySelector('[role="dialog"]');
  const hasBlockEditor = () => container.querySelector("[data-block-editor]") !== null;
  const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

  /** Whether closing the tab would ask first: the page's beforeunload guard. */
  function leaveIsGuarded() {
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    return leave.defaultPrevented;
  }

  function stored(initial?: ComposerInitial) {
    return JSON.parse(localStorage.getItem(draftKey(initial)) ?? "null")?.data;
  }

  /** Writes a crash-recovery draft for the composer to offer on its next mount. */
  function storeDraft(data: object, initial?: ComposerInitial) {
    const draft = {
      topicId: "",
      segmentId: "",
      name: "Launch",
      from: HTML_ROW.from,
      subject: "Hi",
      replyTo: "",
      html: "",
      text: "",
      document: null,
      ...data,
    };
    localStorage.setItem(draftKey(initial), JSON.stringify({ savedAt: Date.now(), data: draft }));
  }

  /** Writes a crash-recovery draft, mounts over it, and restores it. */
  async function recover(data: object, initial?: ComposerInitial) {
    storeDraft(data, initial);
    await mount(initial);
    await click("common.draftRestore");
  }

  describe("where the switch is offered", () => {
    it("offers Edit as HTML beside the tabs of a block body", () => {
      const out = renderToStaticMarkup(createElement(BroadcastComposer, { initial: BLOCK_ROW }));
      expect(out).toMatch(/templates\.html\.editAsHtml<\/button>.*broadcasts\.composer\.editTab/);
      expect(out).not.toContain(BACK_TO_BLOCKS);
    });

    it("offers nothing to switch on an html-authored body, on the preview or in the source", async () => {
      await mount(HTML_ROW);
      // The banner carries Edit HTML here: this body is already source.
      expect(container.textContent).toContain("templates.html.banner");
      expect(buttonFor(EDIT_AS_HTML)).toBeUndefined();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      await click("templates.html.editHtml");
      expect(source()).not.toBeNull();
      expect(buttonFor(EDIT_AS_HTML)).toBeUndefined();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      await click("broadcasts.composer.previewTab");
      expect(buttonFor(EDIT_AS_HTML)).toBeUndefined();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
    });

    it("offers it on a new broadcast, whose empty body starts in the block editor", async () => {
      await mountNew();
      expect(hasBlockEditor()).toBe(true);
      expect(buttonFor(EDIT_AS_HTML)).toBeDefined();
    });

    it("keeps the switch off while a save is in flight", async () => {
      await mount(BLOCK_ROW);
      rq.saving = true;
      await mount(BLOCK_ROW);
      expect(buttonFor(EDIT_AS_HTML)?.disabled).toBe(true);
    });

    it("keeps Back to blocks off while a save is in flight", async () => {
      await switched();
      rq.saving = true;
      await mount(BLOCK_ROW);
      expect(buttonFor(BACK_TO_BLOCKS)?.disabled).toBe(true);
    });

    it("keeps the banner's Convert and the template picker off while a save is in flight", async () => {
      rq.templates = TEMPLATE_ROWS;
      await mount(HTML_ROW);
      expect(buttonFor("templates.html.convert")?.disabled).toBe(false);
      rq.saving = true;
      await mount(HTML_ROW);
      expect(buttonFor("templates.html.convert")?.disabled).toBe(true);
      expect(buttonFor("Legacy HTML")?.disabled).toBe(true);
      expect(buttonFor("Fresh blocks")?.disabled).toBe(true);
    });
  });

  describe("switching to HTML", () => {
    it("switches an empty new broadcast on the spot, with no dialog", async () => {
      await mountNew();
      await click(EDIT_AS_HTML);
      expect(dialog()).toBeNull();
      expect(rq.render).not.toHaveBeenCalled();
      expect(source()?.value).toBe("");
      expect(hasBlockEditor()).toBe(false);
      expect(document.activeElement?.id).toBe("bc-html");
      // Nothing is stored yet, so there is nothing to lose by leaving.
      expect(leaveIsGuarded()).toBe(false);
      // No block document yet, so there is no way back to offer.
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      // The choice outlives a reload even while the html is empty.
      await advance(800);
      expect(stored()).toMatchObject({ html: "", document: null, asCode: true });
    });

    it("keeps the source editor when the user clears the html", async () => {
      await mountNew();
      await click(EDIT_AS_HTML);
      await type("textarea#bc-html", "<p>Hand-written</p>");
      await type("textarea#bc-html", "");
      expect(source()).not.toBeNull();
      expect(hasBlockEditor()).toBe(false);
    });

    it("keeps the source editor when the user clears the html of an html-authored row", async () => {
      await mount(HTML_ROW);
      await click("templates.html.editHtml");
      await type("textarea#bc-html", "");
      expect(source()).not.toBeNull();
      expect(hasBlockEditor()).toBe(false);
    });

    it("opens a body saved empty in the block editor again: the row has no field for the mode", async () => {
      await recover({ html: "", text: "", asCode: true });
      expect(source()?.value).toBe("");
      await click(SAVE);
      expect(rq.create).toHaveBeenCalledOnce();
      expect(rq.create.mock.calls[0]?.[0]).not.toHaveProperty("html");
      expect(rq.create.mock.calls[0]?.[0]).not.toHaveProperty("document");
      // The edit page mounts the composer anew on the created row.
      const created = { ...HTML_ROW, html: null, text: null, document: null };
      await act(async () =>
        root.render(createElement(BroadcastComposer, { key: "created", initial: created })),
      );
      expect(hasBlockEditor()).toBe(true);
      expect(source()).toBeNull();
      expect(buttonFor(EDIT_AS_HTML)).toBeDefined();
    });

    it("switches an empty block document on the spot and can put it back", async () => {
      await mountNew();
      await editBlocks(MAILY_DOC);
      await click(EDIT_AS_HTML);
      expect(dialog()).toBeNull();
      expect(rq.render).not.toHaveBeenCalled();
      expect(source()?.value).toBe("");
      await click(BACK_TO_BLOCKS);
      expect(dialog()).toBeNull();
      expect(rq.blockEditor?.value.document).toBe(MAILY_DOC);
    });

    it("treats a stored empty block document the same way", async () => {
      await mount(EMPTY_ROW);
      await click(EDIT_AS_HTML);
      expect(dialog()).toBeNull();
      expect(rq.render).not.toHaveBeenCalled();
      expect(source()).not.toBeNull();
    });

    it("asks first for a block body with content, and offers no copy of a one-off broadcast", async () => {
      await mount(BLOCK_ROW);
      await click(EDIT_AS_HTML);
      expect(dialog()?.textContent).toContain("templates.html.switchTitle");
      expect(dialog()?.textContent).toContain("broadcasts.composer.switchBody");
      expect(dialog()?.textContent).toContain(IN_PLACE);
      expect(dialog()?.textContent).not.toContain("templates.html.switchCopy");
      // Nothing happens to the body until the user confirms.
      expect(rq.render).not.toHaveBeenCalled();
      expect(hasBlockEditor()).toBe(true);
      await click("common.cancel");
      expect(dialog()).toBeNull();
      expect(hasBlockEditor()).toBe(true);
    });

    it("renders the document through the server and saves the resulting HTML", async () => {
      await mount(BLOCK_ROW);
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      expect(rq.render).toHaveBeenCalledExactlyOnceWith({
        input: { document: BLOCKS },
        retry: false,
      });
      expect(dialog()).toBeNull();
      expect(source()?.value).toBe("<p>Current</p>");
      expect(document.activeElement?.id).toBe("bc-html");
      // Nothing is stored until the user saves.
      expect(rq.update).not.toHaveBeenCalled();
      await click(SAVE);
      expect(rq.update).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: HTML_ROW.id,
          html: "<p>Current</p>",
          text: "Current",
          document: null,
        }),
      );
    });

    it("asks first for edited blocks on a new broadcast, before their render lands", async () => {
      await mountNew();
      await editBlocks(EDITED);
      await click(EDIT_AS_HTML);
      expect(dialog()?.textContent).toContain("templates.html.switchTitle");
      await click(IN_PLACE);
      expect(rq.render).toHaveBeenCalledExactlyOnceWith({
        input: { document: EDITED },
        retry: false,
      });
      expect(source()?.value).toBe("<p>Current</p>");
    });

    it("switches from the preview tab to the source and focuses it", async () => {
      await mount(BLOCK_ROW);
      await click("broadcasts.composer.previewTab");
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      expect(source()?.value).toBe("<p>Current</p>");
      expect(document.activeElement?.id).toBe("bc-html");
    });

    it("keeps the leave guard armed when the source matches the row's stored html", async () => {
      await switched();
      // The row still holds a block document, so no html can match it.
      await type("textarea#bc-html", BLOCK_ROW.html ?? "");
      expect(leaveIsGuarded()).toBe(true);
    });

    it("renders the document as the editor holds it, not the html that lags behind", async () => {
      await mount(BLOCK_ROW);
      await editBlocks(EDITED);
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      expect(rq.render).toHaveBeenCalledExactlyOnceWith({
        input: { document: EDITED },
        retry: false,
      });
    });

    it("keeps the plain text following the HTML the user writes", async () => {
      await switched();
      await type("textarea#bc-html", "<p>Rewritten</p>");
      await click(SAVE);
      expect(rq.update).toHaveBeenCalledWith(
        expect.objectContaining({ html: "<p>Rewritten</p>", text: "Rewritten", document: null }),
      );
    });

    it("creates a new broadcast without a document once it is written as HTML", async () => {
      await recover({ html: "<p>New</p>", text: "New", asCode: true });
      await click(SAVE);
      expect(rq.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ html: "<p>New</p>", text: "New" }),
      );
      expect(rq.create.mock.calls[0]?.[0]).not.toHaveProperty("document");
    });

    it("reports a failed render inside the dialog, which can't be dismissed while it runs", async () => {
      let fail: (reason: Error) => void = () => {};
      rq.render.mockReturnValue(
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      );
      await mount(BLOCK_ROW);
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      expect(buttonFor("common.cancel")?.disabled).toBe(true);
      await act(async () => container.querySelector<HTMLButtonElement>("[data-escape]")?.click());
      expect(dialog()).not.toBeNull();
      await act(async () => fail(new Error("render failed")));
      expect(dialog()?.textContent).toContain("templates.html.switchError");
      expect(buttonFor("common.cancel")?.disabled).toBe(false);
      // The blocks are untouched, so the user can try again or cancel.
      expect(hasBlockEditor()).toBe(true);
      expect(source()).toBeNull();
    });

    it("opens the dialog again without the last failure", async () => {
      rq.render.mockRejectedValueOnce(new Error("render failed"));
      await mount(BLOCK_ROW);
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      expect(dialog()?.textContent).toContain("templates.html.switchError");
      await click("common.cancel");
      await click(EDIT_AS_HTML);
      expect(dialog()?.textContent).toContain("templates.html.switchTitle");
      expect(dialog()?.textContent).not.toContain("templates.html.switchError");
    });
  });

  describe("back to blocks", () => {
    it("puts the blocks back exactly while the switch is unsaved", async () => {
      await switched();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeDefined();
      await click(BACK_TO_BLOCKS);
      expect(dialog()).toBeNull();
      expect(rq.blockEditor?.value).toEqual({ document: BLOCKS, html: "<p>Blocks</p>" });
      expect(source()).toBeNull();
      await click(SAVE);
      expect(rq.update).toHaveBeenCalledWith(
        expect.objectContaining({ html: "<p>Blocks</p>", text: "Blocks", document: BLOCKS }),
      );
    });

    it("puts the blocks back in the editor from the preview tab", async () => {
      await switched();
      await click("broadcasts.composer.previewTab");
      expect(hasBlockEditor()).toBe(false);
      await click(BACK_TO_BLOCKS);
      expect(hasBlockEditor()).toBe(true);
      expect(rq.blockEditor?.value.document).toBe(BLOCKS);
    });

    it("puts the leave guard back as it was with the blocks", async () => {
      await mount(BLOCK_ROW);
      expect(leaveIsGuarded()).toBe(false);
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      // The row still holds a block document, so leaving now would lose the switch.
      expect(leaveIsGuarded()).toBe(true);
      await click(BACK_TO_BLOCKS);
      expect(leaveIsGuarded()).toBe(false);
    });

    it("keeps the leave guard armed when the blocks had unsaved edits before the switch", async () => {
      await mount(BLOCK_ROW);
      await editBlocks(EDITED);
      expect(leaveIsGuarded()).toBe(true);
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      await click(BACK_TO_BLOCKS);
      expect(rq.blockEditor?.value.document).toBe(EDITED);
      expect(leaveIsGuarded()).toBe(true);
    });

    it("asks before Back to blocks discards HTML edits", async () => {
      await switched();
      await type("textarea#bc-html", "<p>Edited</p>");
      await click(BACK_TO_BLOCKS);
      expect(dialog()?.textContent).toContain("templates.html.backTitle");
      expect(hasBlockEditor()).toBe(false);
      await click("templates.html.backDiscard");
      expect(dialog()).toBeNull();
      expect(rq.blockEditor?.value).toEqual({ document: BLOCKS, html: "<p>Blocks</p>" });
      expect(source()).toBeNull();
    });

    it("keeps the HTML edits when the user cancels that question", async () => {
      await switched();
      await type("textarea#bc-html", "<p>Edited</p>");
      await click(BACK_TO_BLOCKS);
      await click("common.cancel");
      expect(dialog()).toBeNull();
      expect(source()?.value).toBe("<p>Edited</p>");
      expect(buttonFor(BACK_TO_BLOCKS)).toBeDefined();
    });

    it("mirrors the mode into the local draft and clears it with the blocks back", async () => {
      await switched();
      await advance(800);
      expect(stored(BLOCK_ROW)).toMatchObject({
        html: "<p>Current</p>",
        document: null,
        asCode: true,
      });
      await click(BACK_TO_BLOCKS);
      await advance(800);
      expect(localStorage.getItem(draftKey(BLOCK_ROW))).toBeNull();
    });

    it("goes once the switch is saved: the way back is the conversion from the saved HTML", async () => {
      await switched();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeDefined();
      await click(SAVE);
      expect(rq.update).toHaveBeenCalledWith(
        expect.objectContaining({ html: "<p>Current</p>", document: null }),
      );
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      expect(leaveIsGuarded()).toBe(false);
      await click("broadcasts.composer.previewTab");
      await click("templates.html.convert");
      await click(IN_PLACE);
      expect(rq.blockEditor?.value).toEqual({ document: null, html: "<p>Current</p>" });
      expect(rq.blockEditor?.convertHtml).toBe(true);
    });

    it("goes once a new broadcast is created from the switched body", async () => {
      await recover({ html: "<p>Blocks</p>", text: "Blocks", document: BLOCKS });
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      expect(buttonFor(BACK_TO_BLOCKS)).toBeDefined();
      await click(SAVE);
      expect(rq.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ html: "<p>Current</p>", text: "Current" }),
      );
      expect(rq.create.mock.calls[0]?.[0]).not.toHaveProperty("document");
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
    });

    it("forgets the way back once the HTML is converted to blocks instead", async () => {
      await switched();
      await click("broadcasts.composer.previewTab");
      await click("templates.html.convert");
      await click(IN_PLACE);
      // Back as HTML before the parse lands: the old blocks are no longer the way back.
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      expect(source()).not.toBeNull();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      expect(rq.render).toHaveBeenCalledOnce();
    });
  });

  describe("applying a template", () => {
    beforeEach(() => {
      rq.templates = TEMPLATE_ROWS;
    });

    it("drops the way back and lands an html-authored template on its preview", async () => {
      await switched();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeDefined();
      rq.template.mockResolvedValue(HTML_TEMPLATE);
      await click("Legacy HTML");
      expect(rq.confirm).toHaveBeenCalledOnce();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      expect(buttonFor(EDIT_AS_HTML)).toBeUndefined();
      expect(container.textContent).toContain("templates.html.banner");
      expect(hasBlockEditor()).toBe(false);
      expect(leaveIsGuarded()).toBe(true);
      await click("templates.html.editHtml");
      expect(source()?.value).toBe("<p>Legacy</p>");
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
    });

    it("keeps an applied html template in the source editor when the user clears it", async () => {
      await mount(BLOCK_ROW);
      rq.template.mockResolvedValue(HTML_TEMPLATE);
      await click("Legacy HTML");
      await click("templates.html.editHtml");
      await type("textarea#bc-html", "");
      expect(source()).not.toBeNull();
      expect(hasBlockEditor()).toBe(false);
    });

    it("keeps the leave guard armed when the applied source matches the row's stored html", async () => {
      await mount(BLOCK_ROW);
      rq.template.mockResolvedValue(HTML_TEMPLATE);
      await click("Legacy HTML");
      await click("templates.html.editHtml");
      await type("textarea#bc-html", BLOCK_ROW.html ?? "");
      expect(leaveIsGuarded()).toBe(true);
    });

    it("ends a conversion in progress when an html template lands", async () => {
      await mount(HTML_ROW);
      await click("templates.html.convert");
      await click(IN_PLACE);
      expect(rq.blockEditor?.convertHtml).toBe(true);
      rq.template.mockResolvedValue(HTML_TEMPLATE);
      await click("Legacy HTML");
      expect(container.textContent).toContain("templates.html.banner");
      expect(hasBlockEditor()).toBe(false);
    });

    it("drops a template that lands after a save started", async () => {
      let land: (template: typeof HTML_TEMPLATE) => void = () => {};
      rq.template.mockReturnValue(
        new Promise((resolve) => {
          land = resolve;
        }),
      );
      await mount(BLOCK_ROW);
      await click("Legacy HTML");
      rq.saving = true;
      await mount(BLOCK_ROW);
      await act(async () => land(HTML_TEMPLATE));
      // The save in flight would mark the template's body as saved.
      expect(hasBlockEditor()).toBe(true);
      expect(rq.blockEditor?.value.document).toBe(BLOCKS);
      expect(container.textContent).not.toContain("templates.html.banner");
    });

    it("lands a block template in the block editor, whatever mode the body was in", async () => {
      await mount(HTML_ROW);
      expect(hasBlockEditor()).toBe(false);
      rq.template.mockResolvedValue(BLOCK_TEMPLATE);
      await click("Fresh blocks");
      expect(rq.blockEditor?.value).toEqual({ document: OTHER_BLOCKS, html: "<p>Fresh</p>" });
      expect(container.textContent).not.toContain("templates.html.banner");
      expect(source()).toBeNull();
      expect(buttonFor(EDIT_AS_HTML)).toBeDefined();
    });

    it("lands a block template over a switched body as blocks, with the switch to HTML on offer again", async () => {
      await switched();
      rq.template.mockResolvedValue(BLOCK_TEMPLATE);
      await click("Fresh blocks");
      expect(rq.blockEditor?.value).toEqual({ document: OTHER_BLOCKS, html: "<p>Fresh</p>" });
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      await click(EDIT_AS_HTML);
      await click(IN_PLACE);
      // The new source comes from the template's blocks, not the replaced ones.
      expect(rq.render).toHaveBeenLastCalledWith({
        input: { document: OTHER_BLOCKS },
        retry: false,
      });
    });
  });

  describe("recovering a draft", () => {
    it("writes no draft for a row the user leaves untouched", async () => {
      await mount(HTML_ROW);
      await advance(1000);
      expect(localStorage.getItem(draftKey(HTML_ROW))).toBeNull();
      await act(async () =>
        root.render(createElement(BroadcastComposer, { key: "blocks", initial: BLOCK_ROW })),
      );
      await advance(1000);
      expect(localStorage.getItem(draftKey(BLOCK_ROW))).toBeNull();
    });

    it("ends a conversion in progress when an html draft is restored", async () => {
      storeDraft({ html: "<p>Draft</p>", text: "Draft", asCode: true }, HTML_ROW);
      await mount(HTML_ROW);
      await click("templates.html.convert");
      await click(IN_PLACE);
      expect(rq.blockEditor?.convertHtml).toBe(true);
      await click("common.draftRestore");
      expect(source()?.value).toBe("<p>Draft</p>");
      expect(hasBlockEditor()).toBe(false);
    });

    it("keeps the leave guard armed when the restored source matches the row's stored html", async () => {
      await recover({ html: "<p>Draft</p>", text: "Draft", asCode: true }, BLOCK_ROW);
      await type("textarea#bc-html", BLOCK_ROW.html ?? "");
      expect(leaveIsGuarded()).toBe(true);
    });

    it("reopens a draft written as HTML in code mode over a block row", async () => {
      await recover({ html: "<p>Draft</p>", text: "Draft", asCode: true }, BLOCK_ROW);
      expect(source()?.value).toBe("<p>Draft</p>");
      expect(hasBlockEditor()).toBe(false);
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
      await click(SAVE);
      expect(rq.update).toHaveBeenCalledWith(
        expect.objectContaining({ html: "<p>Draft</p>", document: null }),
      );
    });

    it("reopens a draft written as HTML on a new broadcast", async () => {
      await recover({ html: "<p>Draft</p>", text: "Draft", asCode: true });
      expect(source()?.value).toBe("<p>Draft</p>");
      expect(hasBlockEditor()).toBe(false);
    });

    it("keeps an empty HTML draft in code mode", async () => {
      await recover({ html: "", text: "", asCode: true }, BLOCK_ROW);
      expect(source()?.value).toBe("");
      expect(hasBlockEditor()).toBe(false);
    });

    it("infers the mode of an older draft without the flag from its content", async () => {
      await recover({ html: "<p>Older HTML</p>", text: "Older HTML" }, BLOCK_ROW);
      expect(source()?.value).toBe("<p>Older HTML</p>");
      expect(hasBlockEditor()).toBe(false);
      await click(SAVE);
      expect(rq.update).toHaveBeenCalledWith(
        expect.objectContaining({ html: "<p>Older HTML</p>", document: null }),
      );
    });

    it("keeps an older HTML draft in the source editor when the user clears it", async () => {
      await recover({ html: "<p>Older HTML</p>", text: "Older HTML" }, BLOCK_ROW);
      await type("textarea#bc-html", "");
      expect(source()).not.toBeNull();
      expect(hasBlockEditor()).toBe(false);
    });

    it("opens an older block draft in the block editor and saves its document", async () => {
      await recover({ html: "<p>Older</p>", text: "Older", document: EDITED }, HTML_ROW);
      expect(rq.blockEditor?.value).toEqual({ document: EDITED, html: "<p>Older</p>" });
      expect(source()).toBeNull();
      await click(SAVE);
      expect(rq.update).toHaveBeenCalledWith(expect.objectContaining({ document: EDITED }));
    });

    it("drops the way back when a recovered draft replaces the body", async () => {
      localStorage.setItem(
        draftKey(BLOCK_ROW),
        JSON.stringify({
          savedAt: Date.now(),
          data: {
            topicId: "",
            segmentId: "",
            name: "Launch",
            from: HTML_ROW.from,
            subject: "Hi",
            replyTo: "",
            html: "<p>Draft</p>",
            text: "Draft",
            document: null,
            asCode: true,
          },
        }),
      );
      await switched();
      expect(buttonFor(BACK_TO_BLOCKS)).toBeDefined();
      await click("common.draftRestore");
      expect(source()?.value).toBe("<p>Draft</p>");
      expect(buttonFor(BACK_TO_BLOCKS)).toBeUndefined();
    });

    it("sends a recovered block draft back to the block editor, off the preview", async () => {
      await recover(
        { html: "<p>Back</p>", text: "Back", document: EDITED, asCode: false },
        HTML_ROW,
      );
      expect(hasBlockEditor()).toBe(true);
      expect(container.textContent).not.toContain("templates.html.banner");
    });
  });

  describe("renders that land late", () => {
    it("never lets a render that lands after the switch overwrite the source", async () => {
      rq.rendered = { data: { html: "<p>Stale</p>", text: "Stale" } };
      await switched();
      expect(source()?.value).toBe("<p>Current</p>");
      // A later answer to the debounced render finds the source already in place.
      rq.rendered = { data: { html: "<p>Late</p>", text: "Late" } };
      await mount(BLOCK_ROW);
      await advance(1000);
      expect(source()?.value).toBe("<p>Current</p>");
    });

    it("still lets a render update the block body, which has no other source", async () => {
      rq.rendered = { data: { html: "<p>Rendered</p>", text: "Rendered" } };
      await mount(BLOCK_ROW);
      expect(rq.blockEditor?.value.html).toBe("<p>Rendered</p>");
    });
  });
});

describe("send dialog warm-up", () => {
  const offer = (over: Partial<SendPlanWarmup> = {}): SendPlanWarmup => ({
    status: "off",
    domain: "news.example.com",
    bestDay: 0,
    eligible: 9_000,
    inactive: 1_200,
    inactiveSince: new Date("2026-07-20T12:00:00Z"),
    skipInactive: true,
    risky: true,
    plan: {
      perDay: [
        { day: "2026-10-18", count: 1_500 },
        { day: "2026-10-19", count: 2_300 },
        { day: "2026-10-20", count: 4_000 },
      ],
      days: 3,
      finishesAt: new Date("2026-10-20T10:00:00Z"),
    },
    blocked: false,
    horizonDays: 24,
    ...over,
  });
  const render = (props: Partial<Parameters<typeof SendPlanSummary>[0]>) =>
    renderToStaticMarkup(
      createElement(SendPlanSummary, {
        count: 9_000,
        estimate: null,
        cloud: true,
        locale: "en",
        now: new Date("2026-10-18T09:00:00Z"),
        ...props,
      }),
    );

  it("offers a risky send a warm-up first: its plan, the inactive choice and why", () => {
    const out = render({ warmup: offer() });
    expect(out).toContain("broadcasts.guard.riskNoticeNew");
    expect(out).toContain("warmup.off.switch");
    expect(out).toContain("broadcasts.guard.recommended");
    expect(out).toContain("broadcasts.guard.optionNormal");
    expect(out).toContain('aria-label="broadcasts.guard.warmupPlan"');
    expect(out).toContain("broadcasts.guard.inactiveLabel");
    expect(out).toContain("broadcasts.guard.warmupReason");
    // With history, the notice names the domain's best day.
    expect(render({ warmup: offer({ bestDay: 840 }) })).toContain("broadcasts.guard.riskNotice<");
    // The normal pace drops the warm-up's rail and inactive row.
    const normal = render({ warmup: offer(), pace: "normal" });
    expect(normal).not.toContain("broadcasts.guard.warmupPlan");
    expect(normal).not.toContain("broadcasts.guard.inactiveLabel");
  });

  it("shows a warming domain's own plan with no choice, and a paused one's wait with no plan", () => {
    const warming = render({ warmup: offer({ status: "warming", risky: false }) });
    expect(warming).toContain("broadcasts.guard.warmingIntro");
    expect(warming).not.toContain("warmup.off.switch");
    expect(warming).toContain("broadcasts.guard.warmupPlan");
    const paused = render({
      warmup: offer({
        status: "paused",
        risky: false,
        plan: { perDay: [], days: 0, finishesAt: null },
      }),
    });
    expect(paused).toContain("broadcasts.guard.pausedIntro");
    expect(paused).not.toContain("broadcasts.guard.warmupPlan");
    expect(paused).not.toContain("ms-field-error");
  });

  it("paces by the new domain limit in its own words, never blaming capacity or other sends", () => {
    const reset = new Date("2026-10-19T00:00:00Z");
    const estimate = {
      first: 0,
      startsAt: reset,
      finishesAt: new Date("2026-10-20T00:30:00Z"),
      days: 2,
      blocked: false,
      releases: [
        { at: reset, endsAt: new Date("2026-10-19T00:20:00Z"), count: 300 },
        {
          at: new Date("2026-10-20T00:00:00Z"),
          endsAt: new Date("2026-10-20T00:30:00Z"),
          count: 300,
        },
      ],
      planHold: null,
      newDomainHold: { heldBack: 600, resumesAt: reset, domain: "nova.example", cap: 300 },
      planLabel: "Pro",
      planPeriod: "month" as const,
      rung: null,
      horizonDays: 24,
    };
    const out = render({ count: 600, estimate });
    expect(out).toContain("broadcasts.guard.limitReason");
    expect(out).toContain("broadcasts.guard.stepLimitDomain");
    expect(out).toContain("broadcasts.guard.stepFirstReset");
    expect(out).toContain("broadcasts.guard.stepLastReset");
    expect(out).not.toContain("broadcasts.guard.stepStarts");
    expect(out).not.toContain("broadcasts.guard.reason<");
    // Without the limit, the same plan reads as capacity's.
    expect(render({ count: 600, estimate: { ...estimate, newDomainHold: null } })).toContain(
      "broadcasts.guard.stepStarts",
    );
  });

  it("words a sending broadcast's days as the limit's resets while it paces them", () => {
    const rail = (resets: boolean) =>
      renderToStaticMarkup(
        createElement(PacingSteps, {
          sent: [{ at: new Date("2026-10-18T09:00:00Z"), count: 300 }],
          releases: [
            {
              at: new Date("2026-10-19T00:00:00Z"),
              endsAt: new Date("2026-10-19T00:20:00Z"),
              count: 300,
            },
            {
              at: new Date("2026-10-20T00:00:00Z"),
              endsAt: new Date("2026-10-20T00:20:00Z"),
              count: 300,
            },
            {
              at: new Date("2026-10-21T00:00:00Z"),
              endsAt: new Date("2026-10-21T00:20:00Z"),
              count: 100,
            },
          ],
          locale: "en",
          now: new Date("2026-10-18T09:30:00Z"),
          resets,
        }),
      );
    expect(rail(true)).toContain("broadcasts.guard.stepMoreReset");
    expect(rail(true)).toContain("broadcasts.guard.stepLastReset");
    expect(rail(true)).not.toContain("broadcasts.guard.stepMore<");
    expect(rail(false)).toContain("broadcasts.guard.stepMore");
  });

  it("refuses a warm-up past the horizon in place", () => {
    const out = render({ warmup: offer({ status: "warming", risky: false, blocked: true }) });
    expect(out).toContain("deliverability.sendGuard.warmupTooLong");
  });
});
