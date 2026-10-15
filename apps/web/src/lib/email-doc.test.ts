import { describe, expect, it } from "vitest";
import { isEmptyMailyDoc, isMailyDoc } from "./email-doc";

describe("isMailyDoc", () => {
  it("accepts a Tiptap doc node and rejects anything else", () => {
    expect(isMailyDoc({ type: "doc" })).toBe(true);
    expect(isMailyDoc({ type: "doc", content: [] })).toBe(true);
    expect(isMailyDoc({ version: 1, blocks: [] })).toBe(false);
    expect(isMailyDoc(null)).toBe(false);
    expect(isMailyDoc("doc")).toBe(false);
  });
});

describe("isEmptyMailyDoc", () => {
  it("is true for what a fresh editor emits", () => {
    expect(isEmptyMailyDoc({ type: "doc" })).toBe(true);
    expect(isEmptyMailyDoc({ type: "doc", content: [] })).toBe(true);
    expect(isEmptyMailyDoc({ type: "doc", content: [{ type: "paragraph" }] })).toBe(true);
    expect(
      isEmptyMailyDoc({
        type: "doc",
        content: [{ type: "paragraph", attrs: { textAlign: "left" }, content: [] }],
      }),
    ).toBe(true);
  });

  it("is false once the user wrote or inserted anything", () => {
    expect(
      isEmptyMailyDoc({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      }),
    ).toBe(false);
    expect(isEmptyMailyDoc({ type: "doc", content: [{ type: "paragraph" }, { type: "image" }] })).toBe(
      false,
    );
    expect(isEmptyMailyDoc({ type: "doc", content: [{ type: "horizontalRule" }] })).toBe(false);
    // Not a Maily document at all: nothing to call empty.
    expect(isEmptyMailyDoc(null)).toBe(false);
  });
});
