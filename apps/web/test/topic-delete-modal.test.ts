// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TOPIC_EMAILS_WAITING, TOPIC_IN_BROADCAST } from "@/lib/trpc-error";

const catalogs = {
  audience: (await import("../messages/en/audience.json")).default,
  common: (await import("../messages/en/common.json")).default,
};

// The real catalog, so the test reads what the team reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: "en",
        messages: catalogs,
        namespace: namespace as "audience",
      }),
  };
});
// The delete mutation's error, which reset() clears.
const rq = vi.hoisted(() => ({ error: null as { message: string } | null }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    mutate: () => {},
    reset: () => {
      rq.error = null;
    },
    isPending: false,
    isError: rq.error !== null,
    error: rq.error,
  }),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));
vi.mock("@/lib/trpc", () => {
  const at = (): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key === "mutationOptions"
          ? (options: unknown) => options
          : key === "pathFilter"
            ? () => ({})
            : at(),
    });
  return { useTRPC: () => at() };
});

const { TopicDeleteModal } = await import("@/app/(dashboard)/audience/topics/topic-modals");

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

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
  rq.error = null;
  onClose.mockClear();
});

const render = (target: { id: string; name: string } | null) =>
  act(async () => root.render(createElement(TopicDeleteModal, { target, onClose })));
const refusal = () => document.querySelector('[role="dialog"] .ms-field-error')?.textContent;

it("says why a delete was refused", async () => {
  for (const [message, copy] of [
    [
      TOPIC_EMAILS_WAITING,
      "Emails that use this topic are still waiting to go out. Delete the topic once they've gone out.",
    ],
    [TOPIC_IN_BROADCAST, "A broadcast uses this topic, so it can't be deleted."],
    ["INTERNAL_SERVER_ERROR", "Could not delete the topic. Try again."],
  ] as const) {
    rq.error = { message };
    await render({ id: "t1", name: "Product news" });
    expect(refusal()).toBe(copy);
  }
});

it("forgets a refusal on close, so the next topic opens without it", async () => {
  for (const dismiss of [
    () => document.querySelector<HTMLButtonElement>('[role="dialog"] .ms-btn-secondary')?.click(),
    () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  ]) {
    rq.error = { message: TOPIC_EMAILS_WAITING };
    await render({ id: "t1", name: "Product news" });
    expect(refusal()).toBeDefined();
    await act(async () => dismiss());
    await render(null);
    await render({ id: "t2", name: "Changelog" });
    expect(refusal()).toBeUndefined();
  }
  expect(onClose).toHaveBeenCalledTimes(2);
});
