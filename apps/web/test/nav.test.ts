import { describe, expect, it } from "vitest";
import { pickActive, safeNextPath } from "@/lib/nav";

describe("safeNextPath (open-redirect guard)", () => {
  it("allows a plain in-app path", () => {
    expect(safeNextPath("/audience?x=1", "/emails")).toBe("/audience?x=1");
    expect(safeNextPath("/emails", "/emails")).toBe("/emails");
  });

  it("rejects off-site targets and falls back", () => {
    for (const evil of [
      "//host",
      "//evil.com",
      "/\\host",
      "/\\evil.com",
      "https://x",
      "http://x",
      "\\\\host",
      "javascript:alert(1)",
      // The URL parser strips ASCII tab/newline, so these resolve off-site.
      "/\t//evil.com",
      "/\n//evil.com",
      "/\r\n\\evil.com",
      "/emails\u0000",
      "",
      null,
      undefined,
    ]) {
      expect(safeNextPath(evil, "/emails")).toBe("/emails");
    }
  });

  it("keeps percent-encoded slashes as an ordinary same-origin path", () => {
    // %2f/%5c stay literal in the path — browsers never decode them into a
    // second leading slash, so the value is a safe same-origin path.
    expect(safeNextPath("/%2f%2fhost", "/emails")).toBe("/%2f%2fhost");
  });
});

const AUDIENCE_TABS = [
  "/audience",
  "/audience/properties",
  "/audience/segments",
  "/audience/topics",
];

describe("pickActive (Audience tab highlight)", () => {
  it("keeps Contacts active on /audience and every per-audience URL", () => {
    expect(pickActive("/audience", AUDIENCE_TABS)).toBe("/audience");
    expect(pickActive("/audience/abc-123", AUDIENCE_TABS)).toBe("/audience");
    expect(pickActive("/audience/abc-123/contacts/c-9", AUDIENCE_TABS)).toBe("/audience");
  });

  it("lets a nested section beat its parent prefix", () => {
    expect(pickActive("/audience/segments", AUDIENCE_TABS)).toBe("/audience/segments");
    expect(pickActive("/audience/segments/new", AUDIENCE_TABS)).toBe("/audience/segments");
    expect(pickActive("/audience/topics", AUDIENCE_TABS)).toBe("/audience/topics");
  });

  it("returns undefined off-section", () => {
    expect(pickActive("/emails", AUDIENCE_TABS)).toBeUndefined();
  });
});
