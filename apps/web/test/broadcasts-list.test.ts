import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ items: [] as unknown[] }));

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    broadcasts: (await import("../messages/en/broadcasts.json")).default,
    templates: (await import("../messages/en/templates.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: keyof typeof messages) =>
      actual.createTranslator({ locale: "en", messages, namespace }),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => ({ path: path.join(".") }), {
      get: (_target, key: string) => at([...path, key]),
      apply: () => ({ path: path.slice(0, -1).join(".") }),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => ({
    isPending: false,
    isError: false,
    hasNextPage: false,
    data: { pages: [{ items: h.items, nextCursor: null }] },
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/api-sheet", () => ({ ResourceApiButton: () => null }));

const { default: BroadcastsPage } = await import("@/app/(dashboard)/broadcasts/page");

const broadcast = (id: string, segmentName: string | null) => ({
  id,
  name: `Spring sale ${id}`,
  subject: "New arrivals",
  status: "sent",
  segmentName,
  htmlAuthored: false,
  recipients: 1_200,
  createdAt: new Date("2026-10-01T12:00:00Z"),
  held: false,
  sentCount: null,
  finishesAt: null,
  releases: [],
  sent: [],
  newDomainLimit: null,
});

describe("the Broadcasts list", () => {
  it("keeps Targeting on one line, ending in an ellipsis inside its column", () => {
    h.items = [broadcast("b1", "Acme Store - spring list - part 2"), broadcast("b2", null)];
    const html = renderToStaticMarkup(createElement(BroadcastsPage));
    expect(html).not.toContain("ms-cell-clip");
    expect(html).toContain(
      '<td><span class="ms-truncate">Acme Store - spring list - part 2</span></td>',
    );
    // No segment means every contact: a segment in use cannot be deleted.
    expect(html).toContain('<td><span class="ms-truncate">All contacts</span></td>');
  });
});
