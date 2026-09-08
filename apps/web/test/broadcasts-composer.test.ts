import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The composer is a client component; a static render with the data hooks
// stubbed is enough to see which editor mounts and what the body shows.
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
// The block editor never loads in tests: its loader is replaced by a marker.
vi.mock("next/dynamic", () => ({
  default: () => () => createElement("div", { "data-block-editor": "" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useInfiniteQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useMutation: () => ({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), fetchQuery: vi.fn() }),
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

const { BroadcastComposer } = await import("@/app/(dashboard)/broadcasts/composer");

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
