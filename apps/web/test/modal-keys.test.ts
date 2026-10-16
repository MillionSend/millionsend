// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

// A real dialog on the real Modal, whose ⌘↵ listener sits on document.
const { BackToBlocksDialog } = await import("@/app/(dashboard)/templates/html-mode");

let container: HTMLDivElement;
let root: Root;

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
});

it("keeps a dialog's ⌘↵ from reaching the page's own shortcuts", async () => {
  // A page shortcut listens on window, after the dialog's listener on document.
  const page = vi.fn();
  window.addEventListener("keydown", page);
  const onConfirm = vi.fn();
  await act(async () =>
    root.render(createElement(BackToBlocksDialog, { open: true, onClose: () => {}, onConfirm })),
  );
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    ),
  );
  window.removeEventListener("keydown", page);
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(page).not.toHaveBeenCalled();
});
