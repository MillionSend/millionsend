import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({ activities: [] as unknown[] }));

// The real English catalogs, so the test reads what the timeline shows.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    audience: (await import("../messages/en/audience.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "audience" }),
  };
});
vi.mock("next/navigation", () => ({
  useParams: () => ({ contactId: randomUUID() }),
  useRouter: () => ({ push: vi.fn() }),
}));
// Every trpc helper answers with the procedure's path, so useQuery can tell them apart.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => ({ path: path.join(".") }), {
      get: (_target, key: string) => at([...path, key]),
      apply: () => ({ path: path.slice(0, -1).join(".") }),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) =>
    options.path === "audience.contacts.activities"
      ? { isSuccess: true, isError: false, data: data.activities }
      : { isSuccess: false, isError: false, data: undefined },
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/modal", () => ({ Modal: () => null }));

const { default: ContactDetailPage } = await import(
  "@/app/(dashboard)/audience/contacts/[contactId]/page"
);

describe("the contact timeline", () => {
  it("says when a suspension took the contact off the list", () => {
    data.activities = [
      { id: randomUUID(), type: "unsubscribed_team_suspended", data: null, createdAt: new Date() },
      { id: randomUUID(), type: "unsubscribed", data: null, createdAt: new Date() },
    ];
    const html = renderToStaticMarkup(createElement(ContactDetailPage));
    expect(html).toContain("Unsubscribed: a team they belong to was suspended");
    expect(html).toContain(">Unsubscribed<");
  });
});
