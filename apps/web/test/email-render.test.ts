import { describe, expect, it } from "vitest";
import { InvalidEmailDocumentError, renderEmailDocument } from "@/lib/email-render";

const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hi " },
        { type: "variable", attrs: { id: "FIRST_NAME", label: "First name", fallback: "there" } },
      ],
    },
  ],
};

describe("renderEmailDocument", () => {
  it("declares both color schemes so dark-mode clients may adapt", async () => {
    const { html } = await renderEmailDocument(DOC);
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark"/>');
    expect(html).not.toContain('content="light"');
  });

  it("emits worker merge tokens, unresolved", async () => {
    const { html, text } = await renderEmailDocument(DOC);
    expect(html).toContain("{{{FIRST_NAME|there}}}");
    expect(text).toContain("{{{FIRST_NAME|there}}}");
  });

  it("rejects a non-Maily document", async () => {
    await expect(renderEmailDocument({ blocks: [] })).rejects.toBeInstanceOf(
      InvalidEmailDocumentError,
    );
  });
});
