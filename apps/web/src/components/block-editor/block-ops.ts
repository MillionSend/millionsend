import type { Block, BlockDoc, BlockType } from "@/lib/email-blocks/model";

/**
 * Pure block-list reducers for the design canvas. All return a new BlockDoc so
 * React state updates stay referentially honest; `newBlock` takes its id as an
 * argument to stay deterministic (see `createBlock` for the id-minting wrapper).
 */

export function newBlock(type: BlockType, id: string): Block {
  switch (type) {
    case "heading":
      return {
        type,
        id,
        level: 2,
        html: "Heading",
        align: "left",
        color: "#111111",
        fontSize: 28,
        padding: 12,
      };
    case "text":
      return {
        type,
        id,
        html: "<p>Write something…</p>",
        align: "left",
        color: "#333333",
        fontSize: 16,
        padding: 12,
      };
    case "image":
      return { type, id, src: "", alt: "", width: 600, align: "center", padding: 0 };
    case "button":
      return {
        type,
        id,
        label: "Button",
        href: "https://",
        bgColor: "#2563eb",
        textColor: "#ffffff",
        radius: 6,
        align: "center",
        padding: 12,
      };
    case "divider":
      return { type, id, color: "#e5e5e5", thickness: 1, padding: 12 };
    case "spacer":
      return { type, id, height: 24 };
    case "html":
      return { type, id, html: "<p>Custom HTML</p>", padding: 0 };
  }
}

export function createBlock(type: BlockType): Block {
  return newBlock(type, crypto.randomUUID());
}

/** Insert after `afterId`, or append when it is absent/not found. */
export function addBlock(doc: BlockDoc, block: Block, afterId?: string): BlockDoc {
  const index = afterId ? doc.blocks.findIndex((b) => b.id === afterId) : -1;
  if (index === -1) return { ...doc, blocks: [...doc.blocks, block] };
  const blocks = doc.blocks.slice();
  blocks.splice(index + 1, 0, block);
  return { ...doc, blocks };
}

export function updateBlock(doc: BlockDoc, id: string, patch: Partial<Block>): BlockDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)),
  };
}

export function removeBlock(doc: BlockDoc, id: string): BlockDoc {
  return { ...doc, blocks: doc.blocks.filter((b) => b.id !== id) };
}

/** Move a block one slot toward the top (-1) or bottom (1); no-op at the edge. */
export function moveBlock(doc: BlockDoc, id: string, dir: -1 | 1): BlockDoc {
  const index = doc.blocks.findIndex((b) => b.id === id);
  const target = index + dir;
  if (index === -1 || target < 0 || target >= doc.blocks.length) return doc;
  const blocks = doc.blocks.slice();
  const [moved] = blocks.splice(index, 1);
  blocks.splice(target, 0, moved as Block);
  return { ...doc, blocks };
}
