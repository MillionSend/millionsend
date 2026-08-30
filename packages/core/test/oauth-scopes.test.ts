import { expect, it } from "vitest";
import { apiBaseUrl, MCP_SCOPES, mcpResourceUrl } from "../src/oauth-scopes.js";

it("derives the API origin from the dashboard host when no public URL is set", () => {
  expect(apiBaseUrl("https://mail.example.com")).toBe("https://mail.example.com:3001");
  expect(apiBaseUrl("http://localhost:3009")).toBe("http://localhost:3001");
  expect(apiBaseUrl(undefined)).toBe("http://localhost:3001");
});

it("prefers an explicit public API URL over the derived host:port", () => {
  expect(apiBaseUrl("https://app.example.com", "https://api.example.com")).toBe(
    "https://api.example.com",
  );
});

// A doubled slash would make the resource identifier a different string than
// the one MCP clients canonicalize, so every token would fail its audience check.
it("strips a trailing slash so the resource identifier stays canonical", () => {
  expect(mcpResourceUrl("https://app.example.com", "https://api.example.com/")).toBe(
    "https://api.example.com/mcp",
  );
});

it("binds the MCP resource to the same origin the dashboard advertises", () => {
  expect(mcpResourceUrl("https://mail.example.com")).toBe("https://mail.example.com:3001/mcp");
});

// Every scope must have a consent-page translation key (auth.consent.scopes.<scope with _>);
// the advertised list is the contract both apps and the docs enumerate from.
it("advertises a read scope for broadcasts alongside the write scope", () => {
  expect(MCP_SCOPES).toContain("broadcasts:read");
  expect(MCP_SCOPES.indexOf("broadcasts:read")).toBeLessThan(
    MCP_SCOPES.indexOf("broadcasts:write"),
  );
});
