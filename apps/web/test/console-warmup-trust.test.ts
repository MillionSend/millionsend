// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalogs = {
  en: {
    console: (await import("../messages/en/console.json")).default,
    common: (await import("../messages/en/common.json")).default,
  },
  "pt-BR": {
    console: (await import("../messages/pt-BR/console.json")).default,
    common: (await import("../messages/pt-BR/common.json")).default,
  },
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
const { formatRelative } = await import("@/lib/format");
type Warmup = Parameters<typeof WarmupCard>[0]["warmup"];
type Domain = Warmup["domains"][number];

const fresh: Domain = {
  id: "d1",
  name: "mail.fresh.example",
  registeredAt: new Date("2026-10-19T09:00:00Z"),
  ageSource: "rdap",
  ageCheckedAt: new Date("2026-10-19T09:05:00Z"),
  trustedAt: null,
  today: { cap: 100, used: 100, fullAt: new Date("2026-11-18T09:00:00Z") },
  waiting: 37,
  request: null,
};
const trusted: Domain = {
  ...fresh,
  id: "d2",
  name: "news.trusted.example",
  trustedAt: new Date("2026-10-19T10:00:00Z"),
  today: null,
  waiting: 0,
};
const request = {
  id: "r1",
  perDay: 2000,
  sends: "account",
  source: "new",
  note: "People sign up on nova.example and get a confirmation email and a sign-in code.",
  createdAt: new Date(Date.now() - 2 * 3_600_000),
  requesterEmail: "ana@nova.example",
};
const asking: Domain = { ...fresh, request };
const warmup: Warmup = {
  enabled: true,
  trustedAt: null,
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

const render = (over: Partial<Warmup> = {}) =>
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
// DotParts keeps each "·" behind a no-break space.
const text = (element: Element | null | undefined) =>
  element?.textContent?.replaceAll("\u00a0", " ");
const rows = () => [...container.querySelectorAll("tbody tr")].map(text);

describe("the warm-up trust switch", () => {
  it("asks before trusting a domain, and only the confirm trusts it", async () => {
    await render();
    await click(button("Trust"));
    expect(title()).toBe("Trust mail.fresh.example");
    expect(dialog()?.textContent).toContain(
      "The 37 emails the daily limit is holding start going out right away. New mail from this domain sends at the team's full volume from now on.",
    );
    expect(dialog()?.textContent).not.toContain("gets an email");
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

describe("a limit request on the warm-up card", () => {
  it("shows what the limit holds, and under its domain's row what the team asked", async () => {
    await render({ domains: [asking, trusted] });
    expect(rows()).toEqual([
      expect.stringContaining("100 of 100 · full volume Nov 18 · 37 waiting"),
      `Asks for 2,000 a day · Sign-up and account · Goes out today: Nowhere yet · Asked by ana@nova.example · ${formatRelative(request.createdAt, "en")}“People sign up on nova.example and get a confirmation email and a sign-in code.”`,
      expect.stringContaining("news.trusted.example"),
    ]);
    expect(rows()[0]).toMatch(/Trust · Decline$/);
    // Someone no longer on the team, and no note: the line says what is known.
    await render({
      domains: [{ ...asking, request: { ...request, requesterEmail: null, note: null } }],
    });
    expect(rows()[1]).toBe(
      `Asks for 2,000 a day · Sign-up and account · Goes out today: Nowhere yet · ${formatRelative(request.createdAt, "en")}`,
    );
    // Nothing waiting, nothing asked: the row says neither.
    await render({ domains: [{ ...fresh, waiting: 0 }, trusted] });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).not.toContain("waiting");
    expect(button("Decline")).toBeUndefined();
  });

  it("says in the trust dialog that the team hears its limit is lifted", async () => {
    await render({ domains: [asking, trusted] });
    await click(button("Trust"));
    expect(text(dialog())).toContain(
      "New mail from this domain sends at the team's full volume from now on. The team gets an email saying the limit is lifted.",
    );
    await click(cancelButton());
    await click(button("Trust team"));
    expect(text(dialog())).toContain("The team gets an email saying the limit is lifted.");
    await click(cancelButton());
    const other: Domain = { ...asking, id: "d3", name: "news.fresh.example", request };
    await render({ domains: [asking, other] });
    await click(button("Trust team"));
    expect(text(dialog())).toContain(
      "The team gets an email for each of its 2 requests saying the limit is lifted.",
    );
    await click(cancelButton());
    expect(rq.sent).toEqual([]);
  });

  it("asks before declining, in the danger style, and only the confirm declines", async () => {
    await render({ domains: [asking, trusted] });
    await click(button("Decline"));
    expect(title()).toBe("Decline the request for mail.fresh.example?");
    expect(text(dialog())).toContain(
      "Its mail keeps the daily limit for new domains. The team gets an email saying so.",
    );
    expect(confirmButton()?.className).toBe("ms-btn ms-btn-destructive");
    expect(confirmButton()?.textContent).toContain("Decline request");
    await click(cancelButton());
    expect(dialog()).toBeNull();
    await click(button("Decline"));
    await press({ key: "Escape" });
    expect(dialog()).toBeNull();
    expect(rq.sent).toEqual([]);

    await click(button("Decline"));
    await press({ key: "Enter", metaKey: true });
    expect(rq.sent).toEqual([{ requestId: "r1" }]);
    await act(async () => rq.settle?.onError({ message: "not_open" }));
    expect(toast).toHaveBeenCalledWith("Could not decline the request: not_open", "danger");
    expect(dialog()).not.toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    rq.pending = true;
    await render({ domains: [asking, trusted] });
    expect(confirmButton()?.disabled).toBe(true);
    expect(confirmButton()?.querySelector(".ms-spinner")).not.toBeNull();
    rq.pending = false;
    await render({ domains: [asking, trusted] });
    await click(confirmButton());
    await act(async () => rq.settle?.onSuccess());
    expect(dialog()).toBeNull();
    expect(toast).toHaveBeenCalledWith("Request declined for mail.fresh.example");
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("reads in Brazilian Portuguese", async () => {
    lang.locale = "pt-BR";
    await render({ domains: [asking, trusted] });
    expect(rows()[1]).toContain(
      "Pede 2.000 por dia · Cadastro e conta · Hoje: Ainda não envia · Pedido por ana@nova.example",
    );
    await click(button("Recusar"));
    expect(title()).toBe("Recusar o pedido de mail.fresh.example?");
    expect(text(dialog())).toContain(
      "O domínio continua com o limite diário de domínios novos. A equipe recebe um e-mail avisando.",
    );
    expect(confirmButton()?.textContent).toContain("Recusar pedido");
    await click(cancelButton());
    await click(button("Confiar"));
    expect(text(dialog())).toContain(
      "A equipe recebe um e-mail avisando que o limite foi retirado.",
    );
  });
});
