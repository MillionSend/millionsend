import { z } from "zod";

/**
 * Block model for the email editor. A stored `document` jsonb column holds a
 * BlockDoc; the serializer turns it into the inline-styled table HTML that
 * actually ships. `html` fields carry tiptap inline HTML where a merge pill is
 * the literal {{{NAME}}} / {{{NAME|fallback}}} token — see merge-fields.ts.
 */

const alignSchema = z.enum(["left", "center", "right"]);
export type Align = z.infer<typeof alignSchema>;

const headingSchema = z.object({
  type: z.literal("heading"),
  id: z.string(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  html: z.string(),
  align: alignSchema,
  color: z.string(),
  fontSize: z.number(),
  padding: z.number(),
});

const textSchema = z.object({
  type: z.literal("text"),
  id: z.string(),
  html: z.string(),
  align: alignSchema,
  color: z.string(),
  fontSize: z.number(),
  padding: z.number(),
});

const imageSchema = z.object({
  type: z.literal("image"),
  id: z.string(),
  src: z.string(),
  alt: z.string(),
  width: z.number(),
  href: z.string().optional(),
  align: alignSchema,
  padding: z.number(),
});

const buttonSchema = z.object({
  type: z.literal("button"),
  id: z.string(),
  label: z.string(),
  href: z.string(),
  bgColor: z.string(),
  textColor: z.string(),
  radius: z.number(),
  align: alignSchema,
  padding: z.number(),
});

const dividerSchema = z.object({
  type: z.literal("divider"),
  id: z.string(),
  color: z.string(),
  thickness: z.number(),
  padding: z.number(),
});

const spacerSchema = z.object({
  type: z.literal("spacer"),
  id: z.string(),
  height: z.number(),
});

const htmlSchema = z.object({
  type: z.literal("html"),
  id: z.string(),
  html: z.string(),
  padding: z.number(),
});

export const blockSchema = z.discriminatedUnion("type", [
  headingSchema,
  textSchema,
  imageSchema,
  buttonSchema,
  dividerSchema,
  spacerSchema,
  htmlSchema,
]);
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>;

export const blockDocSchema = z.object({
  version: z.literal(1),
  blocks: z.array(blockSchema),
});
export type BlockDoc = z.infer<typeof blockDocSchema>;

/** Safe-parse a stored `document` jsonb (unknown shape) into a BlockDoc. */
export function parseBlockDoc(value: unknown): BlockDoc | null {
  const result = blockDocSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function emptyBlockDoc(): BlockDoc {
  return { version: 1, blocks: [] };
}
