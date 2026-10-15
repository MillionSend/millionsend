import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import enSettings from "../messages/en/settings.json";
import ptBRSettings from "../messages/pt-BR/settings.json";

const h = vi.hoisted(() => ({ grants: [] as unknown[] }));

// The real English catalogs, so the test reads what the team reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    settings: (await import("../messages/en/settings.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "settings" }),
  };
});
vi.mock("@/lib/trpc", () => {
  const at = (): unknown =>
    new Proxy(() => {}, { get: (_, key: string) => (key.endsWith("Options") ? () => ({}) : at()) });
  return { useTRPC: () => at() };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: h.grants, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, reset: () => {}, isPending: false, isError: false }),
}));

const { ConnectedAppsView } = await import(
  "@/app/(dashboard)/settings/connected-apps/connected-apps-view"
);

const grant = {
  clientId: "client-1",
  clientName: "Claude Code",
  clientUri: null,
  userId: "ada",
  userEmail: "ada@example.com",
  scopes: ["offline_access", "emails:send"],
  grantedAt: new Date("2026-10-01T10:00:00Z"),
  own: true,
  allTeams: false,
};

it("shows when each grant expires, or that it lasts until disconnected", () => {
  h.grants = [
    { ...grant, id: "g1", expiresAt: null },
    { ...grant, id: "g2", expiresAt: new Date("2026-11-14T12:00:00Z") },
  ];
  const html = renderToStaticMarkup(createElement(ConnectedAppsView));
  expect(html).toContain("<th>Expires</th>");
  expect(html).toContain("Until you disconnect it");
  expect(html).toContain("Nov 14, 2026");
});

// Revocation bites at the next refresh, so an access token already issued
// keeps working for up to its hour (accessTokenExpiresIn).
it("tells whoever revokes that access ends within the hour an access token lasts", () => {
  expect(enSettings.connectedApps.revokeConfirm.body).toBe(
    "{name} loses access to this team at its next token refresh, within an hour.",
  );
  expect(ptBRSettings.connectedApps.revokeConfirm.body).toBe(
    "{name} perde o acesso a esta equipe na próxima renovação de token, em até uma hora.",
  );
});
