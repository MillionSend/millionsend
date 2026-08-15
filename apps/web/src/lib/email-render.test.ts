import { describe, expect, it } from "vitest";
import { InvalidEmailDocumentError, renderEmailDocument } from "./email-render";

const docWith = (content: unknown[]) => ({ type: "doc", content });

describe("renderEmailDocument", () => {
  it("serializes a variable to the worker's {{{NAME}}} token, unresolved", async () => {
    const { html } = await renderEmailDocument(
      docWith([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi " },
            { type: "variable", attrs: { id: "FIRST_NAME", fallback: null } },
            { type: "text", text: ", " },
            { type: "variable", attrs: { id: "FIRST_NAME", fallback: "there" } },
          ],
        },
      ]),
    );
    expect(html).toContain("{{{FIRST_NAME}}}");
    expect(html).toContain("{{{FIRST_NAME|there}}}");
  });

  it("keeps {{{UNSUBSCRIBE_URL}}} un-encoded inside a button href", async () => {
    const { html } = await renderEmailDocument(
      docWith([
        {
          type: "button",
          attrs: {
            text: "Unsubscribe",
            url: "UNSUBSCRIBE_URL",
            isUrlVariable: true,
            isTextVariable: false,
          },
        },
      ]),
    );
    expect(html).toContain("{{{UNSUBSCRIBE_URL}}}");
    // A percent-encoded token ("%7B%7B%7B") would break the worker's substitution.
    expect(html).not.toContain("%7B");
  });

  it("rejects a non-Maily document (legacy BlockDoc / null)", async () => {
    await expect(renderEmailDocument({ version: 1, blocks: [] })).rejects.toBeInstanceOf(
      InvalidEmailDocumentError,
    );
    await expect(renderEmailDocument(null)).rejects.toBeInstanceOf(InvalidEmailDocumentError);
  });
});
