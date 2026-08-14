import type { ReactNode } from "react";

/* Shared t.rich tag map: <code> in message catalogs renders as an inline
   code pill. Keep en and pt-BR <code> placement identical. */
export const codeRichTags = {
  code: (chunks: ReactNode) => <code className="ms-code">{chunks}</code>,
};
