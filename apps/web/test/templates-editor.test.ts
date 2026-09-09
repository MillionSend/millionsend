import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { blocksCopyName, bodyEditorMode, templateSaveInput } from "@/lib/template-mode";

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
// The block editor never loads in tests: its loader is replaced by a marker.
vi.mock("next/dynamic", () => ({
  default: () => () => createElement("div", { "data-block-editor": "" }),
}));
const rq = vi.hoisted(() => ({
  infinite: { data: undefined as unknown, isPending: false, isError: false, hasNextPage: false },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useInfiniteQuery: () => rq.infinite,
  useMutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
// Any trpc.<path>.<helper>(...) call resolves to an inert options object.
vi.mock("@/lib/trpc", () => {
  // biome-ignore lint/suspicious/noExplicitAny: stand-in for the whole router proxy
  const proxy: any = new Proxy(() => ({}), { get: () => proxy, apply: () => ({}) });
  return { useTRPC: () => proxy };
});
// Portals cannot render statically; the dialog's frame is inlined instead.
vi.mock("@/components/modal", () => ({
  Modal: ({ open, title, children }: { open: boolean; title?: string; children: unknown }) =>
    open ? createElement("div", { role: "dialog" }, title, children as never) : null,
}));

const { TemplateEditor } = await import("@/app/(dashboard)/templates/editor");
const { ConvertBlocksDialog, HtmlCodeMode } = await import("@/app/(dashboard)/templates/html-mode");
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
});

describe("code mode panes", () => {
  const out = renderToStaticMarkup(
    createElement(HtmlCodeMode, {
      html: HTML_ROW.html,
      onChange: () => {},
      mergeFields: [],
      previewSamples: {},
      hasText: false,
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
    expect(out).toMatch(/ms-btn-destructive"[^>]*>templates\.html\.convertInPlace</);
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
    expect(out).toMatch(/ms-btn-destructive"[^>]*>broadcasts\.composer\.convertInPlace /);
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
