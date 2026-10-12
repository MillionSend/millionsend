import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_SCOPES } from "@millionsend/core";
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
    const registered = [...source.matchAll(/tool\(\s*"([a-z_]+)",\s*"([a-z-]+:[a-z]+)"/g)].map(
      ([, name, scope]) => ({ name, scope }),
    );
    expect(registered.length).toBeGreaterThan(0);
    expect(MCP_TOOLS.map(({ name, scope }) => ({ name, scope }))).toEqual(registered);
  });

  // The consent page and this page name each scope as auth.consent.scopes.<scope, ":" as "_">.
  it("labels every scope a connected app can be granted, in each locale", () => {
    for (const locale of ["en", "pt-BR"]) {
      const auth = JSON.parse(
        readFileSync(join(__dirname, `../messages/${locale}/auth.json`), "utf8"),
      ) as { consent: { scopes: Record<string, string> } };
      for (const scope of MCP_SCOPES) {
        expect(auth.consent.scopes[scope.replace(":", "_")], `${locale} ${scope}`).toBeTruthy();
      }
    }
  });
});
