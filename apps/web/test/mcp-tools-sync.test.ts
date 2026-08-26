import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "@/app/(dashboard)/settings/mcp/mcp-tools";

/**
 * The settings → MCP page lists the tools the API's MCP server registers.
 * The registry lives in apps/api/src/mcp.ts (which apps/web cannot import),
 * so this parses the registrations out of its source to catch drift.
 */
describe("MCP tools manifest", () => {
  it("matches the tool registrations in apps/api/src/mcp.ts", () => {
    const source = readFileSync(join(__dirname, "../../api/src/mcp.ts"), "utf8");
    const registered = [...source.matchAll(/tool\(\s*"([a-z_]+)",\s*"([a-z]+:[a-z]+)"/g)].map(
      ([, name, scope]) => ({ name, scope }),
    );
    expect(registered.length).toBeGreaterThan(0);
    expect(MCP_TOOLS.map(({ name, scope }) => ({ name, scope }))).toEqual(registered);
  });
});
