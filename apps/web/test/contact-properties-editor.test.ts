// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { propertyTypeMessage } from "@/lib/trpc-error";

const catalogs = {
  audience: (await import("../messages/en/audience.json")).default,
  common: (await import("../messages/en/common.json")).default,
};

// The real catalog, so the test reads what the team reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: "en",
        messages: catalogs,
        namespace: namespace as "audience",
      }),
  };
});
vi.mock("next/navigation", () => ({
  useParams: () => ({ contactId: "c1" }),
  useRouter: () => ({ push: () => {} }),
}));
// Every trpc helper answers with the procedure's path, so the hooks can tell them apart.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => ({ path: path.join(".") }), {
      get: (_target, key: string) => at([...path, key]),
      apply: () => ({ path: path.slice(0, -1).join(".") }),
    });
  return { useTRPC: () => at([]) };
});
// Reads by procedure path, the update's error, and every update sent (the last
// is the mutation's variables).
const rq = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  error: null as { message: string } | null,
  sent: [] as unknown[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ path }: { path: string }) => ({
    isSuccess: path in rq.data,
    isError: false,
    isFetching: false,
    data: rq.data[path],
  }),
  useMutation: ({ path }: { path: string }) => {
    const error = path === "audience.contacts.update" ? rq.error : null;
    return {
      mutate: (variables: unknown) => rq.sent.push(variables),
      mutateAsync: async () => {},
      reset: () => {
        rq.error = null;
      },
      isPending: false,
      isError: error !== null,
      error,
      variables: rq.sent.at(-1),
    };
  },
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

const { default: ContactDetailPage } = await import(
  "@/app/(dashboard)/audience/contacts/[contactId]/page"
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rq.data = {
    // Plan_Ends held "soon" before it was typed as a date.
    "audience.contacts.get": {
      id: "c1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: null,
      unsubscribed: false,
      createdAt: new Date(),
      properties: { Plan_Ends: "soon", seats: "3" },
    },
    "audience.contacts.topics": [],
    "audience.contacts.segments": [],
    "audience.contacts.activities": [],
    "segments.list": [],
    "audience.properties.defineList": [
      { key: "PLAN_ENDS", type: "date" },
      { key: "seats", type: "number" },
      { key: "renews_on", type: "date" },
    ],
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  rq.error = null;
  rq.sent = [];
});

const render = () => act(async () => root.render(createElement(ContactDetailPage)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const errors = () =>
  [...(dialog()?.querySelectorAll(".ms-field-error") ?? [])].map((e) => e.textContent);
const key = (row: number) =>
  dialog()?.querySelectorAll<HTMLInputElement>('input[placeholder="Key"]')[row];
const value = (row: number) =>
  dialog()?.querySelectorAll<HTMLInputElement>('input[placeholder="Value"]')[row];
const save = () => dialog()?.querySelector<HTMLButtonElement>(".ms-btn-primary");
const cancel = () => dialog()?.querySelector<HTMLButtonElement>(".ms-btn-secondary");
const click = (text: string) =>
  act(async () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === text)?.click(),
  );
/** Types into a field the way React hears it. */
const type = (field: HTMLInputElement | undefined, text: string) =>
  act(async () => {
    if (!field) throw new Error("no field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const openEditor = async () => {
  await render();
  await click("Edit");
};

it("checks a changed value against its key's type, never an untouched old one", async () => {
  await openEditor();
  expect(errors()).toEqual([]);

  await type(value(1), "many");
  expect(errors()).toEqual(["seats must be a number, like 42."]);
  expect(value(1)?.getAttribute("aria-invalid")).toBe("true");
  expect(save()?.disabled).toBe(true);

  await type(value(1), "4");
  await type(value(0), "later");
  expect(errors()).toEqual(["Plan_Ends must be a date, like 2026-01-08."]);

  await type(value(0), "2026-01-08");
  expect(errors()).toEqual([]);
  await act(async () => save()?.click());
  expect(rq.sent).toEqual([
    expect.objectContaining({ properties: { Plan_Ends: "2026-01-08", seats: "4" } }),
  ]);
});

it("keeps a stored key as written, so an untouched value under it never blocks a save", async () => {
  // Written through the API, which keeps keys as sent: " seats" is not seats.
  (rq.data["audience.contacts.get"] as { properties: object }).properties = {
    Plan_Ends: "soon",
    " seats": "many",
  };
  await openEditor();
  expect(errors()).toEqual([]);
  await act(async () => save()?.click());
  expect(rq.sent).toEqual([
    expect.objectContaining({ properties: { Plan_Ends: "soon", " seats": "many" } }),
  ]);
});

it("flags an empty value once a save is tried, and ⌘↵ sends nothing while one is wrong", async () => {
  await openEditor();
  await click("Add property");
  await type(key(2), "renews_on");
  // A key typed before its value isn't flagged mid-entry.
  expect(errors()).toEqual([]);
  expect(save()?.disabled).toBe(false);

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
  });
  expect(errors()).toEqual(["renews_on must be a date, like 2026-01-08."]);
  expect(save()?.disabled).toBe(true);
  expect(rq.sent).toEqual([]);

  await type(value(2), "2026-03-01");
  expect(errors()).toEqual([]);

  // A reopened dialog waits for a new attempt.
  await act(async () => cancel()?.click());
  await click("Edit");
  await click("Add property");
  await type(key(2), "renews_on");
  expect(errors()).toEqual([]);
});

it("shows the server's refusal under its row while the row holds that value", async () => {
  // This page loaded its types before seats became a number.
  rq.data["audience.properties.defineList"] = [];
  await openEditor();
  await type(value(1), "many");
  await act(async () => save()?.click());
  rq.error = { message: propertyTypeMessage("number", "seats") };
  await render();
  expect(errors()).toEqual(["seats must be a number, like 42."]);
  expect(value(1)?.getAttribute("aria-invalid")).toBe("true");
  expect(save()?.disabled).toBe(true);

  await type(value(1), "4");
  expect(errors()).toEqual([]);
  expect(value(1)?.getAttribute("aria-invalid")).toBe("false");

  // A reopened dialog starts clean: on its own, this page doesn't know seats is a number.
  await act(async () => cancel()?.click());
  await click("Edit");
  await type(value(1), "many");
  expect(errors()).toEqual([]);
});
