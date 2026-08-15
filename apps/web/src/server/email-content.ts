import { TRPCError } from "@trpc/server";
import { isMailyDoc } from "@/lib/email-doc";
import { renderEmailDocument } from "@/lib/email-render";
import { hasWellFormedMergeTokens } from "@/lib/merge-fields";

/**
 * Resolve the content to persist for a template/broadcast save. A Maily
 * `document` is the source of truth: html + text are re-rendered from it
 * server-side so the send html never trusts a client-supplied string. A null
 * document (code-mode / legacy escape hatch) or an absent one leaves the
 * incoming html/text untouched. Rejects a document whose render produces a
 * malformed merge token before it can become a send.
 */
export async function resolveEditorSave<
  T extends { document?: unknown; html?: string | undefined; text?: string | undefined },
>(input: T): Promise<T> {
  if (!isMailyDoc(input.document)) return input;
  const { html, text } = await renderEmailDocument(input.document);
  if (!hasWellFormedMergeTokens(html)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A merge field is malformed." });
  }
  return { ...input, html, text };
}
