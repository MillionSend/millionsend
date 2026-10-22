// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorInitial } from "@/app/(dashboard)/templates/editor";
import {
  blocksCopyName,
  bodyEditorMode,
  followingText,
  htmlCopyName,
  plainTextSource,
  templateSaveInput,
} from "@/lib/template-mode";

// The editor pages are client components; a static render with the data hooks
// stubbed is enough to see which editor mounts and what the row shows.
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
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(),
}));
const rq = vi.hoisted(() => ({
  infinite: { data: undefined as unknown, isPending: false, isError: false, hasNextPage: false },
  save: vi.fn(),
  render: vi.fn(),
  /** What the debounced email.render query holds; every other query is empty. */
  rendered: { data: undefined as unknown },
  /** Whether the save mutations report a request in flight. */
  saving: false,
  /** The props the block editor last mounted with. */
  blockEditor: null as null | { value: { document: unknown; html: string }; convertHtml?: boolean },
}));
// The block editor never loads in tests: its loader is replaced by a marker.
vi.mock("next/dynamic", () => ({
  default: () => (props: NonNullable<typeof rq.blockEditor>) => {
    rq.blockEditor = props;
    return createElement("div", { "data-block-editor": "" });
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options?: { input?: object }) =>
    options?.input && "document" in options.input ? rq.rendered : { data: undefined },
  useInfiniteQuery: () => rq.infinite,
  useMutation: () => ({
    mutateAsync: rq.save,
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: rq.saving,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), fetchQuery: rq.render }),
}));
// The router stub keeps inputs available for request assertions.
vi.mock("@/lib/trpc", () => {
  // biome-ignore lint/suspicious/noExplicitAny: stand-in for the whole router proxy
  const proxy: any = new Proxy(() => ({}), {
    get: () => proxy,
    apply: (_target, _receiver, args) => ({ input: args[0] }),
  });
  return { useTRPC: () => proxy };
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

const { TemplateEditor } = await import("@/app/(dashboard)/templates/editor");
const { ConvertBlocksDialog, HtmlCodeMode, SwitchHtmlDialog } = await import(
  "@/app/(dashboard)/templates/html-mode"
);
const { default: TemplatesPage } = await import("@/app/(dashboard)/templates/page");

const MAILY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const HTML_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Legacy",
  subject: null,
  html: '<table><tr><td style="padding:8px">Hi {{{FIRST_NAME|there}}}</td></tr></table>',
  text: null,
  document: null,
};

describe("template mode recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  const storageKey = `ms-draft:template:${HTML_ROW.id}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    rq.save.mockReset().mockResolvedValue({ id: HTML_ROW.id });
    rq.render.mockReset().mockResolvedValue({ html: "<p>Current</p>", text: "Current" });
    rq.rendered = { data: undefined };
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

  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.trim().startsWith(label),
    );
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

  const BLOCKS = { type: "doc", content: [{ type: "image" }] };

  /** A saved block template, switched to HTML in place. */
  async function switchedRow() {
    await act(async () =>
      root.render(createElement(TemplateEditor, { initial: { ...HTML_ROW, document: BLOCKS } })),
    );
    await click("templates.html.editAsHtml");
    await click("templates.html.convertInPlace");
  }

  async function recover(data: object, initial: EditorInitial = HTML_ROW) {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ savedAt: Date.now(), data: { ...data, subject: "", text: "" } }),
    );
    await act(async () => root.render(createElement(TemplateEditor, { initial })));
    await click("common.draftRestore");
  }

  it("restores an older block draft over an HTML row and preserves its document on save", async () => {
    await recover({ ...HTML_ROW, name: "Recovered", document: MAILY_DOC });
    expect(container.querySelector("[data-block-editor]")).not.toBeNull();
    expect(container.querySelector("textarea#tpl-html")).toBeNull();
    await click("templates.editor.save");
    expect(rq.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: HTML_ROW.id, name: "Recovered", document: MAILY_DOC }),
    );
  });

  it("restores an older HTML draft over a block row and saves it without a document", async () => {
    await recover(
      { ...HTML_ROW, html: "<p>Recovered HTML</p>" },
      { ...HTML_ROW, document: MAILY_DOC },
    );
    expect(container.querySelector<HTMLTextAreaElement>("#tpl-html")?.value).toBe(
      "<p>Recovered HTML</p>",
    );
    await click("templates.editor.save");
    expect(rq.save).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<p>Recovered HTML</p>", document: null }),
    );
  });

  it("keeps an empty HTML draft in code mode after recovery", async () => {
    await recover(
      { ...HTML_ROW, html: "", text: "", asCode: true },
      { ...HTML_ROW, document: MAILY_DOC },
    );
    expect(container.querySelector<HTMLTextAreaElement>("#tpl-html")?.value).toBe("");
    expect(container.querySelector("[data-block-editor]")).toBeNull();
  });

  it("records the code mode choice for an empty new template", async () => {
    await act(async () => root.render(createElement(TemplateEditor)));
    await click("templates.html.editAsHtml");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(800));
    const stored = JSON.parse(localStorage.getItem("ms-draft:template:new") ?? "null");
    expect(stored?.data).toMatchObject({ html: "", document: null, asCode: true });
  });

  it("renders a block body through the dialog and saves the resulting HTML", async () => {
    await act(async () =>
      root.render(createElement(TemplateEditor, { initial: { ...HTML_ROW, document: BLOCKS } })),
    );
    await click("templates.html.editAsHtml");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(rq.render).not.toHaveBeenCalled();
    await click("templates.html.convertInPlace");
    expect(rq.render).toHaveBeenCalledExactlyOnceWith({
      input: { document: BLOCKS },
      retry: false,
    });
    expect(container.querySelector<HTMLTextAreaElement>("#tpl-html")?.value).toBe("<p>Current</p>");
    expect(rq.save).not.toHaveBeenCalled();
    await click("templates.editor.save");
    expect(rq.save).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<p>Current</p>", text: "Current", document: null }),
    );
  });

  it("duplicates a block body as HTML without updating the original row", async () => {
    await act(async () =>
      root.render(createElement(TemplateEditor, { initial: { ...HTML_ROW, document: BLOCKS } })),
    );
    await click("templates.html.editAsHtml");
    await click("templates.html.switchCopy");
    expect(rq.render).toHaveBeenCalledExactlyOnceWith({
      input: { document: BLOCKS },
      retry: false,
    });
    expect(rq.save).toHaveBeenCalledExactlyOnceWith({
      name: "Legacy (HTML)",
      subject: "",
      html: "<p>Current</p>",
      text: "Current",
      document: null,
    });
    expect(container.querySelector("[data-block-editor]")).not.toBeNull();
  });

  it("keeps a switched body's plain text following its HTML", async () => {
    await switchedRow();
    await type("textarea#tpl-html", "<p>Rewritten</p>");
    await click("templates.editor.save");
    expect(rq.save).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<p>Rewritten</p>", text: "Rewritten", document: null }),
    );
  });

  it("sends plain text an API caller wrote as stored", async () => {
    const initial = { ...HTML_ROW, html: "<p>A</p>", text: "Written by hand" };
    await act(async () => root.render(createElement(TemplateEditor, { initial })));
    await click("templates.html.editHtml");
    await type("textarea#tpl-html", "<p>B</p>");
    await click("templates.editor.save");
    expect(rq.save).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<p>B</p>", text: "Written by hand" }),
    );
  });

  it("gives a new template written as HTML a plain-text part from that HTML", async () => {
    await act(async () => root.render(createElement(TemplateEditor)));
    await click("templates.html.editAsHtml");
    await type("#tpl-name", "Welcome");
    await type("textarea#tpl-html", "<h1>Hi</h1><p>There</p>");
    await click("templates.editor.save");
    expect(rq.save).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<h1>Hi</h1><p>There</p>", text: "Hi\n\nThere" }),
    );
  });

  it("puts the blocks back exactly while the switch is unsaved", async () => {
    await switchedRow();
    expect(document.activeElement?.id).toBe("tpl-html");
    await click("templates.html.backToBlocks");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(rq.blockEditor?.value.document).toBe(BLOCKS);
    await click("templates.editor.save");
    expect(rq.save).toHaveBeenCalledWith(expect.objectContaining({ document: BLOCKS }));
  });

  it("asks before Back to blocks discards HTML edits", async () => {
    await switchedRow();
    await type("textarea#tpl-html", "<p>Edited</p>");
    await click("templates.html.backToBlocks");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "templates.html.backTitle",
    );
    expect(container.querySelector("[data-block-editor]")).toBeNull();
    await click("templates.html.backDiscard");
    expect(rq.blockEditor?.value.document).toBe(BLOCKS);
  });

  it("converts back from the saved HTML, not the old blocks, once the switch is saved", async () => {
    await switchedRow();
    await click("templates.editor.save");
    expect(container.textContent).not.toContain("templates.html.backToBlocks");
    await click("templates.editor.previewTab");
    await click("templates.html.convert");
    await click("templates.html.convertInPlace");
    expect(rq.blockEditor?.value).toEqual({ document: null, html: "<p>Current</p>" });
    expect(rq.blockEditor?.convertHtml).toBe(true);
  });

  it("leaves the page's save shortcuts alone while a dialog is open", async () => {
    await act(async () =>
      root.render(createElement(TemplateEditor, { initial: { ...HTML_ROW, document: BLOCKS } })),
    );
    await click("templates.html.editAsHtml");
    const press = (key: string) =>
      act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true })));
    await press("Enter");
    await press("s");
    expect(rq.save).not.toHaveBeenCalled();
    // Still kept from the browser's Save Page while the dialog is up.
    const saveKey = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
    await act(async () => window.dispatchEvent(saveKey));
    expect(saveKey.defaultPrevented).toBe(true);
    await click("common.cancel");
    await press("s");
    expect(rq.save).toHaveBeenCalledOnce();
  });

  it("puts the leave guard back as it was with the blocks", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    await switchedRow();
    await click("templates.html.backToBlocks");
    // Nothing is unsaved again, so leaving for a copy needs no prompt.
    await click("templates.html.editAsHtml");
    await click("templates.html.switchCopy");
    expect(ask).not.toHaveBeenCalled();
    expect(rq.save).toHaveBeenCalledOnce();
  });

  it("drops the way back when a recovered draft replaces the body", async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        savedAt: Date.now(),
        data: { ...HTML_ROW, subject: "", text: "", html: "<p>Draft</p>", asCode: true },
      }),
    );
    await switchedRow();
    expect(container.textContent).toContain("templates.html.backToBlocks");
    await click("common.draftRestore");
    expect(container.querySelector<HTMLTextAreaElement>("#tpl-html")?.value).toBe("<p>Draft</p>");
    expect(container.textContent).not.toContain("templates.html.backToBlocks");
  });

  it("forgets the way back once the HTML is converted to blocks instead", async () => {
    await switchedRow();
    await click("templates.editor.previewTab");
    await click("templates.html.convert");
    await click("templates.html.convertInPlace");
    // Back as HTML before the parse lands: the old blocks are no longer the way back.
    await click("templates.html.editAsHtml");
    await click("templates.html.convertInPlace");
    expect(container.querySelector("textarea#tpl-html")).not.toBeNull();
    expect(container.textContent).not.toContain("templates.html.backToBlocks");
  });

  it("keeps the mode switch off while a save is in flight", async () => {
    await switchedRow();
    rq.saving = true;
    await act(async () =>
      root.render(createElement(TemplateEditor, { initial: { ...HTML_ROW, document: BLOCKS } })),
    );
    const back = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("templates.html.backToBlocks"),
    );
    expect(back?.disabled).toBe(true);
  });

  it("keeps the banner's Convert off while a save is in flight", async () => {
    const convert = () =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("templates.html.convert"),
      );
    await act(async () => root.render(createElement(TemplateEditor, { initial: HTML_ROW })));
    expect(convert()?.disabled).toBe(false);
    rq.saving = true;
    await act(async () => root.render(createElement(TemplateEditor, { initial: HTML_ROW })));
    expect(convert()?.disabled).toBe(true);
  });

  it("offers no duplicate when a template that was never saved converts to blocks", async () => {
    await act(async () => root.render(createElement(TemplateEditor)));
    await click("templates.html.editAsHtml");
    await type("textarea#tpl-html", "<p>Hand-written</p>");
    await click("templates.editor.previewTab");
    await click("templates.html.convert");
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("templates.html.convertInPlace");
    expect(dialog?.textContent).not.toContain("templates.html.convertCopy");
  });

  it("reports a failed render inside the dialog, which can't be dismissed while it runs", async () => {
    let fail: (reason: Error) => void = () => {};
    rq.render.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    await act(async () =>
      root.render(createElement(TemplateEditor, { initial: { ...HTML_ROW, document: BLOCKS } })),
    );
    await click("templates.html.editAsHtml");
    await click("templates.html.convertInPlace");
    const cancel = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("common.cancel"),
    );
    expect(cancel?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>("[data-escape]")?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => fail(new Error("render failed")));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "templates.html.switchError",
    );
    expect(cancel?.disabled).toBe(false);
    expect(container.querySelector("[data-block-editor]")).not.toBeNull();
  });

  it("never lets a render that lands after the switch overwrite the source", async () => {
    rq.rendered = { data: { html: "<p>Stale</p>", text: "Stale" } };
    await switchedRow();
    expect(container.querySelector<HTMLTextAreaElement>("#tpl-html")?.value).toBe("<p>Current</p>");
  });
});

describe("template editor mode", () => {
  it("opens an html-authored row on the preview with the banner and no block editor", () => {
    const out = renderToStaticMarkup(createElement(TemplateEditor, { initial: HTML_ROW }));
    expect(out).not.toContain("data-block-editor");
    expect(out).toContain("templates.html.banner");
    expect(out).toContain("templates.html.editHtml");
    expect(out).toContain("templates.html.convert");
    // The stored html is what the preview shows, byte for byte.
    expect(out).toContain("<iframe");
    expect(out).toContain("padding:8px");
  });

  it("opens a block-authored row in the block editor, with no html banner", () => {
    const out = renderToStaticMarkup(
      createElement(TemplateEditor, { initial: { ...HTML_ROW, document: MAILY_DOC } }),
    );
    expect(out).toContain("data-block-editor");
    expect(out).not.toContain("templates.html.banner");
  });

  it("opens a new template in the block editor", () => {
    const out = renderToStaticMarkup(createElement(TemplateEditor, {}));
    expect(out).toContain("data-block-editor");
    expect(out).not.toContain("templates.html.banner");
  });

  it("offers Edit as HTML beside the tabs of a block body only", () => {
    const blocks = renderToStaticMarkup(
      createElement(TemplateEditor, { initial: { ...HTML_ROW, document: MAILY_DOC } }),
    );
    expect(blocks).toMatch(/templates\.html\.editAsHtml<\/button>.*templates\.editor\.editTab/);
    expect(renderToStaticMarkup(createElement(TemplateEditor, {}))).toContain(
      "templates.html.editAsHtml",
    );
    // An html-authored row is already source; its preview banner has Edit HTML.
    const html = renderToStaticMarkup(createElement(TemplateEditor, { initial: HTML_ROW }));
    expect(html).not.toContain("templates.html.editAsHtml");
  });

  it("lays name and subject out as one row", () => {
    const out = renderToStaticMarkup(createElement(TemplateEditor, { initial: HTML_ROW }));
    expect(out).toMatch(/class="ms-tpl-meta"[^>]*>.*id="tpl-name".*id="tpl-subject"/);
  });

  it("derives code mode for html without a Maily document, unless converting or empty", () => {
    const html = "<p>x</p>";
    expect(bodyEditorMode({ document: null, html })).toBe("code");
    expect(bodyEditorMode({ document: { version: 2, blocks: [] }, html })).toBe("code");
    expect(bodyEditorMode({ document: MAILY_DOC, html })).toBe("blocks");
    expect(bodyEditorMode({ document: null, html: "  " })).toBe("blocks");
    expect(bodyEditorMode({ document: null, html, converting: true })).toBe("blocks");
  });

  it("keeps code mode once chosen, even while the html is empty", () => {
    // Edit as HTML on a new template, or an html-authored row cleared out.
    expect(bodyEditorMode({ document: null, html: "", asCode: true })).toBe("code");
    expect(bodyEditorMode({ document: MAILY_DOC, html: "<p>x</p>", asCode: true })).toBe("code");
    // Convert to blocks clears the choice; the editor never arms both.
    expect(bodyEditorMode({ document: null, html: "", converting: true, asCode: true })).toBe(
      "blocks",
    );
  });
});

describe("code mode panes", () => {
  const out = renderToStaticMarkup(
    createElement(HtmlCodeMode, {
      html: HTML_ROW.html,
      onChange: () => {},
      mergeFields: [],
      previewSamples: {},
      text: "",
    }),
  );
  const source = out.indexOf('class="ms-tpl-code-source"');
  const preview = out.indexOf('class="ms-tpl-code-preview"');

  it("gives both panes the same toolbar row, then a body", () => {
    expect(out.match(/class="ms-tpl-code-head"/g)).toHaveLength(2);
    expect(out).toMatch(/ms-tpl-code-head".*?ms-code-editor"/);
    expect(out).toMatch(/ms-tpl-code-head".*?ms-tpl-code-frame"/);
  });

  it("puts Find and Variables in the code pane's toolbar, nothing above the panes", () => {
    const variables = out.indexOf("block-editor.toolbar.variables");
    const find = out.indexOf("templates.html.find");
    expect(variables).toBeGreaterThan(source);
    expect(variables).toBeLessThan(preview);
    expect(find).toBeGreaterThan(source);
    expect(find).toBeLessThan(variables);
    expect(out.slice(0, source)).not.toContain("toolbar.variables");
    // The pane switch for narrow widths is all that sits above the panes.
    expect(out.slice(0, source)).toContain("ms-tpl-code-tabs");
  });

  it("says where the plain-text part comes from", () => {
    const hint = (html: string, text: string) =>
      renderToStaticMarkup(
        createElement(HtmlCodeMode, {
          html,
          onChange: () => {},
          mergeFields: [],
          previewSamples: {},
          text,
        }),
      );
    expect(out).toContain("templates.html.textNone");
    expect(hint("<p>Hi</p>", "Hi")).toContain("templates.html.textDerived");
    expect(hint("<p>Hi</p>", "Written by hand")).toContain("templates.html.textStored");
  });

  it("previews in a same-origin, script-less frame so the scroll survives updates, with links let out", () => {
    expect(out).toMatch(
      /<iframe[^>]*sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"/,
    );
    expect(out).not.toContain("allow-scripts");
  });
});

describe("code-mode save", () => {
  const fields = { name: " Legacy ", subject: " Hi ", html: "<p>x</p>", text: "", document: null };

  it("keeps the row html-authored: document is null even when state holds a legacy shape", () => {
    expect(templateSaveInput("code", { ...fields, document: { version: 2 } })).toEqual({
      name: "Legacy",
      subject: "Hi",
      html: "<p>x</p>",
      text: "",
      document: null,
    });
  });

  it("carries the document through for the block editor", () => {
    expect(templateSaveInput("blocks", { ...fields, document: MAILY_DOC }).document).toEqual(
      MAILY_DOC,
    );
  });

  it("names the converted copy after the original", () => {
    expect(blocksCopyName(" Welcome ")).toBe("Welcome (blocks)");
    expect(htmlCopyName(" Welcome ")).toBe("Welcome (HTML)");
  });
});

describe("code-mode plain text", () => {
  it("follows the html while it was derived from it", () => {
    expect(followingText("Old", "<p>Old</p>", "<p>New</p>")).toBe("New");
    // A body started as HTML: nothing yet, so the first source decides.
    expect(followingText("", "", "<p>Hi</p>")).toBe("Hi");
  });

  it("keeps text an API caller supplied, or left out, as stored", () => {
    expect(followingText("Written by hand", "<p>Old</p>", "<p>New</p>")).toBe("Written by hand");
    expect(followingText("", "<p>Old</p>", "<p>New</p>")).toBe("");
  });

  it("names where the text comes from", () => {
    expect(plainTextSource("Old", "<p>Old</p>")).toBe("derived");
    expect(plainTextSource("Written by hand", "<p>Old</p>")).toBe("stored");
    expect(plainTextSource("", "<p>Old</p>")).toBe("none");
  });
});

describe("convert-to-blocks dialog", () => {
  it("offers the duplicate (primary) and in-place (destructive) actions", () => {
    const out = renderToStaticMarkup(
      createElement(ConvertBlocksDialog, {
        open: true,
        busy: false,
        onClose: () => {},
        onDuplicate: () => {},
        onConvertInPlace: () => {},
        inPlaceLabel: "templates.html.convertInPlace",
      }),
    );
    expect(out).toContain("templates.html.convertTitle");
    expect(out).toContain("templates.html.convertBody");
    expect(out).toMatch(/ms-btn-destructive"[^>]*>(<[^>]*>)*templates\.html\.convertInPlace</);
    expect(out).toMatch(/ms-btn-primary"[^>]*>(<[^>]*>)*templates\.html\.convertCopy /);
    // Flow order: Cancel, then the in-place (destructive) choice, then the primary.
    expect(out.indexOf("common.cancel")).toBeLessThan(out.indexOf("ms-btn-destructive"));
    expect(out.indexOf("ms-btn-destructive")).toBeLessThan(out.indexOf("ms-btn-primary"));
  });

  it("without a duplicate path, converting in place is the only, confirmable action", () => {
    const out = renderToStaticMarkup(
      createElement(ConvertBlocksDialog, {
        open: true,
        onClose: () => {},
        onConvertInPlace: () => {},
        inPlaceLabel: "broadcasts.composer.convertInPlace",
      }),
    );
    expect(out).not.toContain("ms-btn-primary");
    expect(out).not.toContain("templates.html.convertCopy");
    expect(out).toMatch(/ms-btn-destructive"[^>]*>(<[^>]*>)*broadcasts\.composer\.convertInPlace /);
  });

  it("renders nothing while closed", () => {
    const out = renderToStaticMarkup(
      createElement(ConvertBlocksDialog, {
        open: false,
        busy: false,
        onClose: () => {},
        onDuplicate: () => {},
        onConvertInPlace: () => {},
        inPlaceLabel: "templates.html.convertInPlace",
      }),
    );
    expect(out).toBe("");
  });
});

describe("edit-as-html dialog", () => {
  it("offers the duplicate (primary) and in-place (destructive) actions on a saved template", () => {
    const out = renderToStaticMarkup(
      createElement(SwitchHtmlDialog, {
        open: true,
        onClose: () => {},
        onDuplicate: () => {},
        onSwitchInPlace: () => {},
      }),
    );
    expect(out).toContain("templates.html.switchTitle");
    expect(out).toContain("templates.html.switchBody");
    expect(out).toMatch(/ms-btn-destructive"[^>]*>(<[^>]*>)*templates\.html\.convertInPlace</);
    expect(out).toMatch(/ms-btn-primary"[^>]*>(<[^>]*>)*templates\.html\.switchCopy /);
    expect(out.indexOf("ms-btn-destructive")).toBeLessThan(out.indexOf("ms-btn-primary"));
  });

  it("on an unsaved template, switching in place is the only, confirmable action", () => {
    const out = renderToStaticMarkup(
      createElement(SwitchHtmlDialog, {
        open: true,
        onClose: () => {},
        onDuplicate: undefined,
        onSwitchInPlace: () => {},
      }),
    );
    expect(out).not.toContain("ms-btn-primary");
    expect(out).not.toContain("templates.html.switchCopy");
    expect(out).toMatch(/ms-btn-destructive"[^>]*>(<[^>]*>)*templates\.html\.convertInPlace /);
  });

  it("shows a failure inside the dialog, and locks every button while an action runs", () => {
    const failed = renderToStaticMarkup(
      createElement(SwitchHtmlDialog, {
        open: true,
        error: "templates.html.switchError",
        onClose: () => {},
        onSwitchInPlace: () => {},
      }),
    );
    expect(failed).toMatch(/role="alert"[^>]*>templates\.html\.switchError</);
    const running = renderToStaticMarkup(
      createElement(SwitchHtmlDialog, {
        open: true,
        pending: "inPlace",
        onClose: () => {},
        onDuplicate: () => {},
        onSwitchInPlace: () => {},
      }),
    );
    expect(running.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });
});

describe("templates list", () => {
  it("marks html-authored rows with the HTML chip and its hint", () => {
    rq.infinite.data = {
      pages: [
        {
          items: [
            { id: "a", name: "Legacy", updatedAt: new Date(), htmlAuthored: true },
            { id: "b", name: "Blocks", updatedAt: new Date(), htmlAuthored: false },
          ],
          nextCursor: null,
        },
      ],
    };
    const out = renderToStaticMarkup(createElement(TemplatesPage));
    expect(out.match(/class="ms-chip"[^>]*>HTML</g)).toHaveLength(1);
    // The hint rides a hover tooltip (its panel only exists while open), so
    // the chip sits inside a tooltip trigger, beside the row's name link.
    // The name stays on one line inside its link, so the chip never wraps under it.
    expect(out).toMatch(
      /<span class="ms-truncate">Legacy<\/span><\/a><span class="ms-tooltip-trigger inline"[^>]*><span class="ms-chip"/,
    );
  });
});
