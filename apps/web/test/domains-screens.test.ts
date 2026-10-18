import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// What the list query answers, and the page's query string.
const h = vi.hoisted(() => ({
  list: [] as unknown[],
  search: "",
}));

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    domains: (await import("../messages/en/domains.json")).default,
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
  useSearchParams: () => new URLSearchParams(h.search),
}));
// Each procedure's options name its path.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") ? () => ({ path: path.join(".") }) : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ path }: { path: string }) =>
    path === "domains.list"
      ? {
          data: h.list,
          isPending: false,
          isError: false,
          isSuccess: true,
        }
      : { data: undefined, isPending: true, isError: false, isSuccess: false },
  useMutation: () => ({ mutate: () => {}, isPending: false, isError: false }),
}));
// Dialogs and drawers portal to document.body, which a server render does not have.
vi.mock("@/components/modal", () => ({ Modal: () => null }));
vi.mock("@/components/api-sheet", () => ({ ResourceApiButton: () => null }));

const { DomainsView } = await import("@/app/(dashboard)/domains/domains-table");

const own = (name: string, status: string) => ({
  id: name,
  name,
  region: "us-east-1",
  status,
  createdAt: new Date(),
  trackingPending: false,
});
function page(p: { list: unknown[]; search?: string }) {
  h.list = p.list;
  h.search = p.search ?? "";
  // A name's break points (Breakable) put back together.
  const html = renderToStaticMarkup(createElement(DomainsView, { awsBanner: null })).replaceAll(
    "<wbr/>",
    "",
  );
  const rows = html.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr>.*?<\/tr>/gs) ?? [];
  return { html, rows };
}

describe("the Domains page", () => {
  const owned = [own("mail.acme.example", "verified"), own("news.acme.example", "pending")];

  it("lists the team's own domains, each with a link and a menu, and counts them", () => {
    const { html, rows } = page({ list: owned });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain('aria-label="More actions"');
    expect(rows[0]).toContain('href="/domains/mail.acme.example"');
    expect(html).toContain("Page 1 – 1 of 2 domains");
  });

  it("shows the no-match card alone when the filters match no domain", () => {
    const { html, rows } = page({ list: owned, search: "q=agents" });
    expect(rows).toHaveLength(0);
    expect(html).not.toContain("<table");
    expect(html).toContain("None of your domains match the filters.");
    expect(html).not.toContain("Page 1 –");
  });

  it("shows the empty state alone when the team has no domain", () => {
    const { html } = page({ list: [] });
    expect(html).not.toContain("<table");
    expect(html).toContain("No domains of your own yet.");
    expect(html).toContain('href="/domains/new"');
    // Nothing to filter.
    expect(html).not.toContain('class="ms-filter-row"');
  });
});
