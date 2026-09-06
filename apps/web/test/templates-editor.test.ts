import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { blocksCopyName, templateEditorMode, templateSaveInput } from "@/lib/template-mode";

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
const { ConvertBlocksDialog } = await import("@/app/(dashboard)/templates/html-mode");
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

  it("derives code mode for anything but a Maily document, unless converting", () => {
    expect(templateEditorMode({ isNew: false, document: null })).toBe("code");
    expect(templateEditorMode({ isNew: false, document: { version: 2, blocks: [] } })).toBe("code");
    expect(templateEditorMode({ isNew: false, document: MAILY_DOC })).toBe("blocks");
    expect(templateEditorMode({ isNew: true, document: null })).toBe("blocks");
    expect(templateEditorMode({ isNew: false, document: null, converting: true })).toBe("blocks");
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

  it("renders nothing while closed", () => {
    const out = renderToStaticMarkup(
      createElement(ConvertBlocksDialog, {
        open: false,
        busy: false,
        onClose: () => {},
        onDuplicate: () => {},
        onConvertInPlace: () => {},
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
    expect(out).toMatch(
      /Legacy<\/a><span class="ms-tooltip-trigger inline"[^>]*><span class="ms-chip"/,
    );
  });
});
