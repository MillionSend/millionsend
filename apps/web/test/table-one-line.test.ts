import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../src/styles/components.css", import.meta.url)),
  "utf8",
);

/** A rule's body when it sits at the top level: rules inside a media query are indented. */
const topLevel = (selector: string) =>
  css.match(new RegExp(`\\n${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("every list row is one line", () => {
  it("keeps the whole table on one line at every width", () => {
    expect(topLevel("table.ms-table")).toContain("white-space: nowrap;");
    expect(topLevel(".ms-table wbr")).toContain("display: none;");
  });

  it("lets a paragraph row opt out, at every width too", () => {
    expect(topLevel(".ms-table td.ms-cell-wrap")).toContain("white-space: normal;");
  });

  it("gives the date column its width at every width", () => {
    expect(topLevel(".ms-table th.ms-col-date")).toContain("width: 104px;");
  });
});
