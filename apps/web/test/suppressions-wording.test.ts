import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  rows: [] as unknown[],
  detail: undefined as unknown,
}));

// The real catalogs, so the test reads what the team reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const catalogs = {
    en: {
      emails: (await import("../messages/en/emails.json")).default,
      common: (await import("../messages/en/common.json")).default,
      "bounce-guidance": (await import("../messages/en/bounce-guidance.json")).default,
    },
    "pt-BR": {
      emails: (await import("../messages/pt-BR/emails.json")).default,
      common: (await import("../messages/pt-BR/common.json")).default,
      "bounce-guidance": (await import("../messages/pt-BR/bounce-guidance.json")).default,
    },
  };
  return {
    ...actual,
    useLocale: () => h.locale,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: h.locale,
        messages: catalogs[h.locale],
        namespace: namespace as "emails",
      }),
  };
});
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "suppression-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
// Every trpc helper answers with the procedure's path, so the query mocks can tell them apart.
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
    data: { pages: [{ items: h.rows, total: h.rows.length, nextCursor: null }] },
  }),
  useQuery: (options: { path: string }) => ({
    isPending: false,
    isError: false,
    data: options.path === "emails.suppressions.get" ? h.detail : undefined,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/api-sheet", () => ({ ApiDocsButton: () => null }));

const { default: SuppressionsPage } = await import("@/app/(dashboard)/emails/suppressions/page");
const { default: SuppressionDetailPage } = await import(
  "@/app/(dashboard)/emails/suppressions/[id]/page"
);

const row = (id: string, email: string, fullMailbox: boolean) => ({
  id,
  email,
  reason: "hard_bounce",
  fullMailbox,
  createdAt: new Date("2026-10-01T12:00:00Z"),
});

function detail(fullMailbox: boolean, bounceType: string) {
  h.detail = {
    ...row("suppression-1", "box@example.com", fullMailbox),
    sourceEmailId: "email-1",
    bounce: {
      bounceType,
      bounceSubType: fullMailbox ? "MailboxFull" : "General",
      bouncedRecipients: [{ diagnosticCode: "smtp; 552 5.2.2 mailbox full" }],
    },
  };
  return renderToStaticMarkup(createElement(SuppressionDetailPage));
}

describe("a suppression a full or inactive mailbox left", () => {
  it("reads as such in the list, and a hard bounce still reads as a bounce", () => {
    h.locale = "en";
    h.rows = [row("a", "box@example.com", true), row("b", "gone@example.com", false)];
    const html = renderToStaticMarkup(createElement(SuppressionsPage));
    expect(html).toContain(">Full or inactive mailbox</span>");
    expect(html).toContain(">Bounce</span>");

    h.locale = "pt-BR";
    expect(renderToStaticMarkup(createElement(SuppressionsPage))).toContain(
      ">Caixa cheia ou inativa</span>",
    );
  });

  it("names its origin on the detail without the soft bounce's class or a dash", () => {
    h.locale = "en";
    const html = detail(true, "Transient");
    expect(html).toContain(">Full or inactive mailbox</div>");
    expect(html).not.toContain("transient");
    expect(html).not.toContain("—");
    expect(html).toContain("This mailbox answered full or inactive.");
    expect(html).not.toContain("bounced permanently");
  });

  it("keeps a permanent bounce's origin, joined without a dash", () => {
    h.locale = "en";
    const html = detail(false, "Permanent");
    expect(html).toContain(">Bounce · permanent</div>");
    expect(html).toContain("An address that bounced permanently will likely bounce again.");
  });
});

describe("the suppression list", () => {
  it("keeps each address on one line, ending in an ellipsis inside its column", () => {
    h.locale = "en";
    h.rows = [row("a", "box@example.com", false)];
    const html = renderToStaticMarkup(createElement(SuppressionsPage));
    expect(html).not.toContain("ms-cell-wrap");
    expect(html).not.toContain("<wbr");
    expect(html).toContain(
      '<a class="ms-lead-value" href="/emails/suppressions/a"><span class="ms-truncate">box@example.com</span></a>',
    );
  });
});
