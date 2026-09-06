import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type SelectOption, SelectOptionList } from "@/components/select";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

const options: SelectOption[] = [
  { value: "all", label: "All sources" },
  { value: "api_key", label: "All API keys", group: "API keys" },
  {
    value: "api_key:k1",
    label: "Production",
    hint: "ms_live_…ab12",
    group: "API keys",
    badge: { label: "revoked", tone: "neutral" },
  },
  { value: "mcp", label: "All connected apps", group: "MCP" },
  { value: "mcp:c1", label: "Claude", group: "MCP" },
];

function render(opts: SelectOption[]) {
  return renderToStaticMarkup(
    createElement(SelectOptionList, {
      options: opts,
      value: "api_key:k1",
      activeIndex: 3,
      listboxId: "lb",
      onHover: () => {},
      onPick: () => {},
    }),
  );
}

describe("Select option groups", () => {
  it("draws one heading per run of grouped options, none for ungrouped rows", () => {
    const html = render(options);
    const headings = [
      ...html.matchAll(/<div class="ms-menu-label" role="presentation">([^<]*)<\/div>/g),
    ].map((m) => m[1]);
    expect(headings).toEqual(["API keys", "MCP"]);
    // Order: ungrouped row, heading, its rows, heading, its rows.
    const order = [
      "All sources",
      "API keys",
      "All API keys",
      "Production",
      "MCP",
      "All connected apps",
      "Claude",
    ];
    const positions = order.map((text) => html.indexOf(`>${text}<`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("keeps headings out of the option sequence: ids stay contiguous and headings are not options", () => {
    const html = render(options);
    expect(html.match(/role="option"/g)).toHaveLength(5);
    expect([...html.matchAll(/id="lb-(\d)"/g)].map((m) => Number(m[1]))).toEqual([0, 1, 2, 3, 4]);
    expect(html).not.toMatch(/<button[^>]*class="ms-menu-label"/);
    expect(html).toContain(
      'id="lb-3" type="button" role="option" aria-selected="false" tabindex="-1" class="ms-menu-item active"',
    );
  });

  it("renders the hint and badge inside the option row", () => {
    const html = render(options);
    expect(html).toContain("ms_live_…ab12");
    expect(html).toContain('class="ms-badge ms-badge-neutral"');
    expect(html).toContain("revoked");
  });

  it("a filtered list whose group emptied loses that group's heading", () => {
    const html = render(options.filter((o) => o.group !== "MCP"));
    expect(html).toContain(">API keys<");
    expect(html).not.toContain(">MCP<");
  });
});
