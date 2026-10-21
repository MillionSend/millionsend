// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalogs = {
  en: { console: (await import("../messages/en/console.json")).default },
  "pt-BR": { console: (await import("../messages/pt-BR/console.json")).default },
};
const lang = vi.hoisted(() => ({ locale: "en" as "en" | "pt-BR" }));

// The real catalogs, so the test reads what the operator reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => lang.locale,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: lang.locale,
        messages: catalogs[lang.locale],
        namespace: namespace as "console",
      }),
  };
});
// Every trust change sent, the callbacks it went with, and whether one is in flight.
const rq = vi.hoisted(() => ({
  pending: false,
  sent: [] as unknown[],
  settle: null as { onSuccess: () => void; onError: (error: { message: string }) => void } | null,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    mutate: (variables: unknown, settle: typeof rq.settle) => {
      rq.sent.push(variables);
      rq.settle = settle;
    },
    isPending: rq.pending,
  }),
}));
vi.mock("@/lib/trpc", () => {
  const at = (): unknown => new Proxy(() => {}, { get: () => at(), apply: () => ({}) });
  return { useTRPC: () => at() };
});
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/toast", () => ({ toast }));

const { WarmupCard } = await import("@/components/console/safety/review-view");

const fresh = {
  id: "d1",
  name: "mail.fresh.example",
  registeredAt: new Date("2026-10-19T09:00:00Z"),
  ageSource: "rdap",
  ageCheckedAt: new Date("2026-10-19T09:05:00Z"),
  trustedAt: null,
  today: { cap: 100, used: 100, fullAt: new Date("2026-11-18T09:00:00Z") },
  waiting: 37,
};
const trusted = {
  ...fresh,
  id: "d2",
  name: "news.trusted.example",
  trustedAt: new Date("2026-10-19T10:00:00Z"),
  today: null,
  waiting: 0,
};
const warmup = {
  enabled: true,
  trustedAt: null as Date | null,
  domains: [fresh, trusted],
  pool: { cap: 100, used: 100 },
  waiting: 37,
};

let container: HTMLDivElement;
let root: Root;
const onChanged = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Object.assign(rq, { pending: false, sent: [], settle: null });
  lang.locale = "en";
  toast.mockClear();
  onChanged.mockClear();
});

const render = (over: Partial<typeof warmup> = {}) =>
  act(async () =>
    root.render(
      createElement(WarmupCard, {
        team: { id: "t1", name: "Acme" },
        warmup: { ...warmup, ...over },
        onChanged,
      }),
    ),
  );
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const title = () => dialog()?.querySelector("h2")?.textContent;
const confirmButton = () =>
  dialog()?.querySelector<HTMLButtonElement>(".ms-btn-primary, .ms-btn-destructive");
const cancelButton = () => dialog()?.querySelector<HTMLButtonElement>(".ms-btn-secondary");
const click = (element: HTMLElement | null | undefined) => act(async () => element?.click());
const press = (init: KeyboardEventInit) =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });

describe("the warm-up trust switch", () => {
  it("asks before trusting a domain, and only the confirm trusts it", async () => {
    await render();
    await click(button("Trust"));
    expect(title()).toBe("Trust mail.fresh.example");
    expect(dialog()?.textContent).toContain(
      "The 37 emails the daily limit is holding start going out right away. New mail from this domain sends at the team's full volume from now on.",
    );
    expect(cancelButton()?.textContent).toBe("CancelEsc");
    await click(cancelButton());
    expect(dialog()).toBeNull();
    await click(button("Trust"));
    await press({ key: "Escape" });
    expect(dialog()).toBeNull();
    expect(rq.sent).toEqual([]);

    await click(button("Trust"));
    expect(confirmButton()?.className).toBe("ms-btn ms-btn-primary");
    expect(confirmButton()?.textContent).toContain("Trust domain");
    await click(confirmButton());
    expect(rq.sent).toEqual([{ teamId: "t1", trusted: true, domainId: "d1" }]);
    // Open until the change lands, then a toast and a fresh read of the page.
    expect(dialog()).not.toBeNull();
    await act(async () => rq.settle?.onSuccess());
    expect(dialog()).toBeNull();
    expect(toast).toHaveBeenCalledWith("Warm-up lifted for mail.fresh.example");
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("asks before trusting the team, ⌘↵ confirming it", async () => {
    await render();
    await click(button("Trust team"));
    expect(title()).toBe("Trust Acme");
    expect(dialog()?.textContent).toContain(
      "The 37 emails the daily limit is holding start going out right away. New mail from all of the team's domains sends at full volume from now on.",
    );
    await click(cancelButton());
    expect(rq.sent).toEqual([]);
    await click(button("Trust team"));
    await press({ key: "Enter", metaKey: true });
    expect(rq.sent).toEqual([{ teamId: "t1", trusted: true }]);
  });

  it("asks before removing trust, in the danger style, and says what trust still covers", async () => {
    await render();
    await click(button("Remove trust"));
    expect(title()).toBe("Remove trust from news.trusted.example");
    expect(dialog()?.textContent).toContain(
      "New mail from this domain goes back under the daily limit for new domains.",
    );
    expect(confirmButton()?.className).toBe("ms-btn ms-btn-destructive");
    await click(cancelButton());
    await render({ trustedAt: new Date("2026-10-19T11:00:00Z") });
    await click(button("Remove trust"));
    expect(dialog()?.textContent).toContain(
      "The team's own trust still covers this domain, so it keeps sending at full volume.",
    );
    await click(cancelButton());
    await click(button("Remove team trust"));
    expect(title()).toBe("Remove trust from Acme");
    expect(dialog()?.textContent).toContain(
      "New mail from the team's domains goes back under the daily limit for new domains. The domain trusted on its own stays trusted.",
    );
    expect(rq.sent).toEqual([]);
    await click(confirmButton());
    expect(rq.sent).toEqual([{ teamId: "t1", trusted: false }]);
  });

  it("holds the confirm while a change is in flight, and stays open when it fails", async () => {
    await render();
    await click(button("Trust"));
    rq.pending = true;
    await render();
    expect(confirmButton()?.disabled).toBe(true);
    expect(confirmButton()?.querySelector(".ms-spinner")).not.toBeNull();
    await press({ key: "Enter", metaKey: true });
    expect(rq.sent).toEqual([]);
    rq.pending = false;
    await render();
    await click(confirmButton());
    await act(async () => rq.settle?.onError({ message: "Failed to fetch" }));
    expect(toast).toHaveBeenCalledWith("Could not change trust: Failed to fetch", "danger");
    expect(dialog()).not.toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("says when nothing is waiting, and reads in Brazilian Portuguese", async () => {
    await render({ waiting: 0 });
    await click(button("Trust team"));
    expect(dialog()?.textContent).toContain(
      "The daily limit is not holding any of this team's mail.",
    );
    await press({ key: "Escape" });
    lang.locale = "pt-BR";
    await render({ domains: [{ ...fresh, waiting: 1 }, trusted] });
    await click(button("Confiar"));
    expect(title()).toBe("Confiar em mail.fresh.example");
    expect(dialog()?.textContent).toContain(
      "O e-mail que o limite diário está segurando sai na hora. A partir de agora, os novos e-mails deste domínio saem no volume total da equipe.",
    );
    expect(confirmButton()?.textContent).toContain("Confiar no domínio");
    expect(cancelButton()?.textContent).toBe("CancelarEsc");
  });
});
