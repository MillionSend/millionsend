import { z } from "zod";
import { mailyDocumentSchema } from "@/lib/email-doc";
import { renderEmailDocument } from "@/lib/email-render";
import { router, teamProcedure } from "../trpc";

export const emailRouter = router({
  /** Render a Maily document to send-ready html + text for the live preview.
   * Send html is re-rendered on save (see server/email-content.ts); this is the
   * same render, ahead of persistence, so the preview matches the eventual send. */
  render: teamProcedure
    .input(z.object({ document: mailyDocumentSchema }))
    .query(({ input }) => renderEmailDocument(input.document)),
});
