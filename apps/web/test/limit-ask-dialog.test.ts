// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalogs = {
  en: {
    domains: (await import("../messages/en/domains.json")).default,
    common: (await import("../messages/en/common.json")).default,
  },
  "pt-BR": {
    domains: (await import("../messages/pt-BR/domains.json")).default,
    common: (await import("../messages/pt-BR/common.json")).default,
  },
};
const lang = vi.hoisted(() => ({ locale: "en" as "en" | "pt-BR" }));

// The real catalogs, so the test reads what the team reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => lang.locale,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: lang.locale,
        messages: catalogs[lang.locale],
        namespace: namespace as "domains",
      }),
  };
});
// Every request sent, the callbacks it went with, and the mutation's state.
const rq = vi.hoisted(() => ({
  pending: false,
  error: null as { data: { code: string } } | null,
  sent: [] as unknown[],
  options: null as { onSuccess: () => void; onSettled: () => void } | null,
  invalidated: 0,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: typeof rq.options) => {
    rq.options = options;
    return {
      mutate: (variables: unknown) => rq.sent.push(variables),
      reset: () => {
        rq.error = null;
      },
      isPending: rq.pending,
      isError: rq.error !== null,
      error: rq.error,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: () => {
      rq.invalidated += 1;
      return Promise.resolve();
    },
  }),
}));
vi.mock("@/lib/trpc", () => {
  const at = (): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key === "mutationOptions"
          ? (options: unknown) => options
          : key === "queryKey"
            ? () => []
            : at(),
    });
  return { useTRPC: () => at() };
});
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/toast", () => ({ toast }));

const { LimitSection } = await import("@/app/(dashboard)/domains/[id]/limit-section");

const NOW = new Date("2026-10-20T18:00:00Z");
const limit = {
  domainId: "d1",
  name: "nova.example",
  cap: 300,
  used: 300,
  pool: null,
  waiting: 214,
  resetsAt: new Date("2026-10-21T00:00:00Z"),
  registeredAt: new Date("2026-10-17T15:00:00Z"),
  steps: [
    { from: NOW, cap: 300 },
    { from: new Date("2026-10-24T15:00:00Z"), cap: 2000 },
    { from: new Date("2026-11-16T15:00:00Z"), cap: null },
  ],
  fullAt: new Date("2026-11-16T15:00:00Z"),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no matchMedia; reduced motion lands the stat strip's digits at once.
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  // Nor scrolling: the select's list scrolls its active option into view.
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Object.assign(rq, { pending: false, error: null, sent: [], options: null, invalidated: 0 });
  lang.locale = "en";
  toast.mockClear();
});

const render = () =>
  act(async () =>
    root.render(
      createElement(LimitSection, {
        domainId: "d1",
        domain: "nova.example",
        limit,
        request: null,
        canManage: true,
      }),
    ),
  );
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent === label);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const submit = () => dialog()?.querySelector<HTMLButtonElement>(".ms-btn-primary");
const cancel = () => dialog()?.querySelector<HTMLButtonElement>(".ms-btn-secondary");
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | null | undefined)?.click());
const press = (init: KeyboardEventInit) =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
/** Types into a field the way React hears it. */
const type = (selector: string, value: string) =>
  act(async () => {
    const field = dialog()?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!field) throw new Error(`no ${selector}`);
    const proto = Object.getPrototypeOf(field) as object;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const choose = async (label: string, option: string) => {
  await click(dialog()?.querySelector(`[aria-label="${label}"]`));
  await click(
    [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === option),
  );
};

describe("asking for a higher limit", () => {
  it("asks what the domain sends, how much and from where, and sends the answers", async () => {
    await render();
    await click(button("Ask for a higher limit"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Ask for a higher limit");
    const text = dialog()?.textContent ?? "";
    expect(text).toContain(
      "nova.example sends up to 300 emails a day for now. Tell us what it sends and we'll review the limit. Your mail keeps going out at the current pace meanwhile.",
    );
    for (const label of [
      "What will it send?",
      "About how many a day?",
      "Where does it go out today?",
      "Anything else? optional",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Sign-up and account emails");
    expect(text).toContain("Nowhere yet, it's a new product");
    expect(cancel()?.textContent).toBe("Cancel Esc");

    await choose("What will it send?", "A mix of these");
    await choose("Where does it go out today?", "Another email provider");
    await type("#limit-ask-per-day", "2,000");
    await type("#limit-ask-note", "  People sign up and get a sign-in code.  ");
    await click(submit());
    expect(rq.sent).toEqual([
      {
        id: "d1",
        sends: "mix",
        perDay: 2000,
        source: "other_provider",
        note: "People sign up and get a sign-in code.",
      },
    ]);
    // Open until the request lands, then a toast and a fresh read of the domain.
    expect(dialog()).not.toBeNull();
    await act(async () => {
      rq.options?.onSuccess();
      rq.options?.onSettled();
    });
    expect(dialog()).toBeNull();
    expect(toast).toHaveBeenCalledWith("Request sent. We'll email you when it's reviewed.");
    expect(rq.invalidated).toBe(1);
  });

  it("sends nothing without a count in range, saying what to fix, by click or ⌘↵", async () => {
    await render();
    await click(button("Ask for a higher limit"));
    await press({ key: "Enter", metaKey: true });
    expect(rq.sent).toEqual([]);
    expect(dialog()?.textContent).toContain("Enter how many emails a day, from 1 to 10,000,000.");
    await type("#limit-ask-per-day", "about none");
    await click(submit());
    expect(rq.sent).toEqual([]);
    await type("#limit-ask-per-day", "20,000,000");
    await click(submit());
    expect(rq.sent).toEqual([]);
    expect(dialog()?.textContent).toContain("from 1 to 10,000,000");
    // The note stops where the server would refuse it.
    expect(dialog()?.querySelector("#limit-ask-note")?.getAttribute("maxlength")).toBe("1000");
    await type("#limit-ask-per-day", "500");
    await press({ key: "Enter", metaKey: true });
    expect(rq.sent).toEqual([{ id: "d1", sends: "account", perDay: 500, source: "new" }]);
    expect(dialog()?.textContent).not.toContain("Enter how many");
  });

  it("holds the button while the request is in flight, so it never goes twice", async () => {
    await render();
    await click(button("Ask for a higher limit"));
    await type("#limit-ask-per-day", "2000");
    rq.pending = true;
    await render();
    expect(submit()?.disabled).toBe(true);
    expect(submit()?.querySelector(".ms-spinner")).not.toBeNull();
    await press({ key: "Enter", metaKey: true });
    expect(rq.sent).toEqual([]);
  });

  it("closes on Esc or Cancel without sending", async () => {
    await render();
    await click(button("Ask for a higher limit"));
    await press({ key: "Escape" });
    expect(dialog()).toBeNull();
    await click(button("Ask for a higher limit"));
    await click(cancel());
    expect(dialog()).toBeNull();
    expect(rq.sent).toEqual([]);
  });

  it("says a refusal in plain words and stays open", async () => {
    await render();
    await click(button("Ask for a higher limit"));
    const refusals = [
      ["CONFLICT", "You already asked for this domain. We'll email you when it's reviewed."],
      ["PRECONDITION_FAILED", "This domain has no daily limit anymore."],
      ["BAD_REQUEST", "Check the answers and try again."],
      ["INTERNAL_SERVER_ERROR", "Couldn't send the request. Try again."],
    ] as const;
    for (const [code, copy] of refusals) {
      rq.error = { data: { code } };
      await render();
      expect(dialog()?.textContent).toContain(copy);
    }
    expect(toast).not.toHaveBeenCalled();
  });

  it("reads in Brazilian Portuguese", async () => {
    lang.locale = "pt-BR";
    await render();
    await click(button("Pedir um limite maior"));
    const text = dialog()?.textContent ?? "";
    expect(text).toContain(
      "nova.example envia até 300 e-mails por dia por enquanto. Conte para a gente o que ele envia e a gente revisa o limite.",
    );
    expect(text).toContain("O que ele vai enviar?");
    expect(text).toContain("Por onde ele sai hoje?");
    expect(text).toContain("Ainda não sai, é um produto novo");
    expect(submit()?.textContent).toContain("Enviar pedido");
  });
});
