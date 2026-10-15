import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// What the list and shared queries answer, and the page's query string.
const h = vi.hoisted(() => ({
  list: [] as unknown[],
  shared: null as unknown,
  search: "",
}));

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    domains: (await import("../messages/en/domains.json")).default,
    common: (await import("../messages/en/common.json")).default,
    inboxes: (await import("../messages/en/inboxes.json")).default,
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
    path === "domains.list" || path === "domains.shared"
      ? {
          data: path === "domains.list" ? h.list : h.shared,
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
const sharedRow = (sharedSending: { mode: string; cause: string | null }) => ({
  id: "s1",
  name: "acme.agents.example",
  region: "us-east-1",
  createdAt: new Date(),
  sharedSending,
});

function page(p: { list: unknown[]; shared: unknown; search?: string }) {
  h.list = p.list;
  h.shared = p.shared;
  h.search = p.search ?? "";
  // A name's break points (Breakable) put back together.
  const html = renderToStaticMarkup(createElement(DomainsView, { awsBanner: null })).replaceAll(
    "<wbr/>",
    "",
  );
  const rows = html.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr>.*?<\/tr>/gs) ?? [];
  return { html, rows };
}

describe("the Domains page's shared subdomain", () => {
  const owned = [own("mail.acme.example", "verified"), own("news.acme.example", "pending")];

  it("comes first, read-only, with its sending mode, outside the count", () => {
    const { html, rows } = page({
      list: owned,
      shared: sharedRow({ mode: "reply_only", cause: "plan" }),
    });
    const [first, ...rest] = rows;
    expect(first).toContain("acme.agents.example");
    expect(first).toContain('class="ms-badge ms-badge-neutral">Shared<');
    expect(first).toContain(">replies only on the Free plan<");
    // No link to a detail page and no menu: there is nothing to set up or delete.
    expect(first).not.toContain("<a ");
    expect(first).not.toContain('aria-label="More actions"');
    expect(rest).toHaveLength(2);
    for (const row of rest) expect(row).toContain('aria-label="More actions"');
    expect(rest[0]).toContain('href="/domains/mail.acme.example"');
    expect(html).toContain("Page 1 – 1 of 2 domains");

    const open = page({ list: owned, shared: sharedRow({ mode: "open", cause: null }) });
    expect(open.rows[0]).toContain(">can start conversations<");
  });

  it("stays above the no-match card when the filters match no own domain", () => {
    // Its own name matches: the filters read the team's own domains only.
    const { html, rows } = page({
      list: owned,
      shared: sharedRow({ mode: "open", cause: null }),
      search: "q=agents",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("acme.agents.example");
    expect(html.indexOf("None of your domains match the filters.")).toBeGreaterThan(
      html.indexOf("</table>"),
    );
    expect(html).not.toContain("Page 1 –");
  });

  it("sits above the empty state when the team has no own domain", () => {
    const { html, rows } = page({
      list: [],
      shared: sharedRow({ mode: "receive_only", cause: "instance" }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(">sending paused<");
    expect(html.indexOf("No domains of your own yet.")).toBeGreaterThan(html.indexOf("</table>"));
    expect(html).toContain('href="/domains/new"');
    // Nothing to filter.
    expect(html).not.toContain('class="ms-filter-row"');

    // Without the row (no shared domain, or its name review pending), the empty state alone.
    const alone = page({ list: [], shared: null });
    expect(alone.html).not.toContain("<table");
    expect(alone.html).toContain("No domains of your own yet.");
  });
});
