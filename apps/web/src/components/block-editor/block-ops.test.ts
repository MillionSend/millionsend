import { describe, expect, it } from "vitest";
import { type BlockDoc, type BlockType, blockSchema } from "@/lib/email-blocks/model";
import { addBlock, moveBlock, newBlock, removeBlock, updateBlock } from "./block-ops";

const TYPES: BlockType[] = ["heading", "text", "image", "button", "divider", "spacer", "html"];

function docOf(...ids: string[]): BlockDoc {
  return { version: 1, blocks: ids.map((id) => newBlock("spacer", id)) };
}

describe("newBlock", () => {
  it("produces a schema-valid default for every type", () => {
    for (const type of TYPES) {
      expect(blockSchema.safeParse(newBlock(type, "x")).success).toBe(true);
    }
  });
});

describe("block reducers", () => {
  it("appends when no anchor and inserts after the anchor", () => {
    const base = docOf("a", "b");
    expect(addBlock(base, newBlock("text", "c")).blocks.map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(addBlock(base, newBlock("text", "c"), "a").blocks.map((b) => b.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("removes by id", () => {
    expect(removeBlock(docOf("a", "b"), "a").blocks.map((b) => b.id)).toEqual(["b"]);
  });

  it("patches only the target block", () => {
    const out = updateBlock(docOf("a", "b"), "a", { height: 99 });
    const a = out.blocks.find((b) => b.id === "a");
    expect(a?.type === "spacer" && a.height).toBe(99);
    expect(out.blocks.find((b) => b.id === "b")).toEqual(docOf("a", "b").blocks[1]);
  });

  it("moves within bounds and is a no-op at the edges", () => {
    const base = docOf("a", "b", "c");
    expect(moveBlock(base, "a", 1).blocks.map((b) => b.id)).toEqual(["b", "a", "c"]);
    expect(moveBlock(base, "c", -1).blocks.map((b) => b.id)).toEqual(["a", "c", "b"]);
    expect(moveBlock(base, "a", -1)).toBe(base);
    expect(moveBlock(base, "c", 1)).toBe(base);
  });
});
